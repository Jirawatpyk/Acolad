# One-command, single-instance-safe deploy. NEVER `pm2 restart` by hand - always this.
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as the system ANSI codepage
# (no BOM), so a non-ASCII char (em-dash, arrow) in CODE corrupts the token and fails to parse.
#
# Two bots share this host, and releasing or restarting either one must leave the other
# completely untouched (003 FR-026, acceptance item V12):
#
#   npm run deploy                     xtm      acolad-bot        47811  ecosystem.config.cjs
#   npm run deploy -- -Target straker  straker  jobcatch-straker  47812  straker.config.cjs
#   npm run deploy -- -Target both     xtm first, then straker; a failure stops the rest
#
# The default is 'xtm', so the bare command still does exactly what it did when this
# script knew about one bot: one build, then release acolad-bot - and no other PM2
# application on the host is stopped, started or otherwise touched.
param(
  [ValidateSet('xtm', 'straker', 'both')]
  [string]$Target = 'xtm'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# One descriptor per bot. Every value under `xtm` is the literal this script used inline
# when it knew about a single bot: the XTM release path changed in where it reads its
# constants, never in what it runs with them.
#
# LogGlob is where step 5/5 looks for proof of life, and each one is coupled to TWO
# settings rather than one - the pino-roll base name, which is a constant in the bot's
# source, AND the log directory, which is an env var with a default and can therefore be
# moved in .env alone. Both halves, for both bots:
#
#   bot      base name                                   log directory (default 'logs')
#   xtm      'acolad'          src/monitoring/logger.ts  LOG_DIR
#   straker  STRAKER_LOG_NAME  src/straker/logger.ts     STRAKER_LOG_DIR
#
# Change either half without changing the glob here and a perfectly healthy deploy FAILs
# its verify step - which invites exactly the manual `pm2 restart` this script exists to
# make unnecessary. This script deliberately does not read .env (the same convention that
# has the lock ports below kept in sync by hand), so setting STRAKER_LOG_DIR=logs/straker
# and leaving this table alone is enough to break a healthy deploy. If step 5/5 FAILs on a
# bot that is plainly running, check the glob against BOTH halves before touching PM2.
$Bots = @{
  xtm     = @{
    App       = 'acolad-bot'
    Port      = 47811
    Ecosystem = 'ecosystem.config.cjs'
    LogGlob   = 'logs/acolad.*.log'
    ReadyLine = '"action":"cycle","outcome":"ok"'
    ReadyName = 'poll cycle ok'
    # The XTM bot drives Chromium, so an orphan holding the lock port owns browser
    # children that outlive it. Straker is HTTP-only - there is no such child to sweep.
    SweepChromiumChildren = $true
  }
  straker = @{
    App       = 'jobcatch-straker'
    Port      = 47812
    Ecosystem = 'straker.config.cjs'
    # Both halves of this glob are load-bearing - the 'logs' directory is STRAKER_LOG_DIR's
    # default, the base name is STRAKER_LOG_NAME. See the LogGlob note above the table.
    LogGlob   = 'logs/jobcatch-straker.*.log'
    # The SAME marker the XTM bot uses, which is what DC-3 asks of both loops: it proves a
    # cycle completed, not merely that a process started. `startStrakerBot`'s runOnce emits
    # it on every cycle including a quiet one that found no offers, so a healthy bot with
    # an empty board still verifies.
    ReadyLine = '"action":"cycle","outcome":"ok"'
    ReadyName = 'poll cycle ok'
    SweepChromiumChildren = $false
  }
}

function Port-Holder($p) {
  (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess)
}
function Wait-PortFree($p, $timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Port-Holder $p)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# Steps 2..5 for ONE bot. Every pm2 command here is scoped to $App and every port check to
# $Port, which is what keeps a release of one bot off the other: nothing in this function
# addresses "all apps" except `pm2 save`, which only rewrites the dump and starts or stops
# nothing.
#
# $banner heads the section with the bot's name, and is passed only when one run covers
# more than one bot. A single-bot run therefore prints character-for-character what this
# script printed before it knew about a second bot - which is the point: `npm run deploy`
# is the live XTM bot's release path and should be unchanged right down to its output.
function Release-Bot($bot, $banner) {
  $App       = $bot.App
  $Port      = $bot.Port
  $Ecosystem = $bot.Ecosystem
  $logGlob   = $bot.LogGlob
  $readyLine = $bot.ReadyLine
  $readyName = $bot.ReadyName

  if ($banner) { Write-Host "== release $App ==" }
  Write-Host '== 2/5 stop + wait for port free =='
  pm2 stop $App | Out-Null
  if (-not (Wait-PortFree $Port 45)) {
    # 3/5 orphan sweep - the lock port is this bot's signature, so the holder IS an orphan.
    Write-Host '== 3/5 orphan still holds the lock port - sweeping =='
    $orphan = Port-Holder $Port
    if ($orphan) {
      if ($bot.SweepChromiumChildren) {
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
          Where-Object { $_.ParentProcessId -eq $orphan } |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      }
      Stop-Process -Id $orphan -Force -ErrorAction SilentlyContinue
      if (-not (Wait-PortFree $Port 10)) { throw "port $Port still held by PID $orphan after sweep" }
      $swept = if ($bot.SweepChromiumChildren) { ' + its Chromium children' } else { '' }
      Write-Host "  killed orphan PID $orphan$swept"
    }
  }

  Write-Host '== 4/5 start + save =='
  pm2 start $Ecosystem | Out-Null
  pm2 save | Out-Null
  if (-not (pm2 prettylist 2>$null | Select-String "name: '$App'")) { throw "pm2 dump missing $App" }

  Write-Host '== 5/5 verify (<=90s) =='
  # Re-resolve the newest log each iteration: pino-roll's daily index is NOT monotonic with
  # time across restarts, and it may rotate mid-window - selecting once up front can watch a
  # stale file and false-FAIL a healthy deploy (which would invite a banned manual restart).
  $mark = (Get-Date)
  $ok = $false
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $log = Get-ChildItem "$root/$logGlob" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime | Select-Object -Last 1
    if ($log -and $log.LastWriteTime -gt $mark) {
      if (Get-Content $log.FullName -Tail 40 | Select-String $readyLine) {
        $ok = $true; break
      }
    }
    Start-Sleep -Seconds 3
  }
  $holder = Port-Holder $Port
  # Single-instance proof: the OS allows only one listener on $Port, so a held port already
  # rules out a second poller. Cross-check that PM2's one online $App IS that holder
  # (catches a started-but-failed-to-bind process). `pm2 pid` prints the PID(s) as plain
  # numbers - robust, unlike `pm2 jlist | ConvertFrom-Json` (PS5.1 chokes on the env block's
  # duplicate username/USERNAME keys) or a WMI main.js match (PM2's fork wrapper hides it).
  $pm2Pids = @((pm2 pid $App) | Where-Object { $_ -match '^\d+$' })
  # Renders exactly the old message for the XTM bot; names the right signal for Straker,
  # whose ready line is a different one (see the descriptor).
  if (-not $ok)     { throw ('FAIL: no fresh "' + $readyName + '" within 90s') }
  if (-not $holder) { throw 'FAIL: lock port not held after start' }
  if ($pm2Pids.Count -ne 1 -or [int]$pm2Pids[0] -ne [int]$holder) {
    throw "FAIL: single-instance check - pm2 pids [$($pm2Pids -join ',')] != port holder $holder"
  }
  Write-Host "PASS: deployed, single instance (PID $holder holds port $Port), cycle ok" -ForegroundColor Green
}

Push-Location $root
try {
  Write-Host '== 1/5 build =='
  npm run build
  # PS 5.1: $? is unreliable for native exe exit codes - gate on $LASTEXITCODE so a tsc
  # error aborts here instead of redeploying a stale/broken dist/.
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  # One tsc run produces both bots' dist/, so the build stays a single step. Releases then
  # run in order and stop at the first failure, so -Target both can never leave the second
  # bot started off a build the first one rejected.
  $order = switch ($Target) {
    'xtm'     { @('xtm') }
    'straker' { @('straker') }
    'both'    { @('xtm', 'straker') }
  }

  # Bulkhead guard (FR-024/FR-026): a mistyped port or app name in the table above would
  # let a Straker release stop the live XTM bot - the one outcome the split exists to
  # prevent. EVERY descriptor in this run is checked in its own pass first, so the guard
  # fails while nothing has been stopped yet. Inside the release loop it did not: for
  # -Target both it reached the straker entry only on the second iteration, by which time
  # Release-Bot had already stopped and restarted the LIVE XTM bot - doing the damage the
  # guard exists to prevent before reporting that it was possible.
  foreach ($name in $order) {
    $bot = $Bots[$name]
    if ($name -ne 'xtm' -and ($bot.Port -eq $Bots.xtm.Port -or $bot.App -eq $Bots.xtm.App)) {
      throw "bot register broken: $($bot.App) collides with the XTM bot's port or app name"
    }
  }

  foreach ($name in $order) {
    $bot = $Bots[$name]
    Release-Bot $bot ($order.Count -gt 1)
  }
}
finally {
  Pop-Location
}
