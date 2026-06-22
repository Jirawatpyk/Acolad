# One-command, single-instance-safe deploy. NEVER `pm2 restart` by hand - always this.
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as the system ANSI codepage
# (no BOM), so a non-ASCII char (em-dash, arrow) in CODE corrupts the token and fails to parse.
$ErrorActionPreference = 'Stop'
$App  = 'acolad-bot'
$Port = 47811
$root = Split-Path -Parent $PSScriptRoot

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

Push-Location $root
try {
  Write-Host '== 1/5 build =='
  npm run build
  # PS 5.1: $? is unreliable for native exe exit codes - gate on $LASTEXITCODE so a tsc
  # error aborts here instead of redeploying a stale/broken dist/.
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  Write-Host '== 2/5 stop + wait for port free =='
  pm2 stop $App | Out-Null
  if (-not (Wait-PortFree $Port 45)) {
    # 3/5 orphan sweep - the lock port is acolad's signature, so the holder IS an orphan.
    Write-Host '== 3/5 orphan still holds the lock port - sweeping =='
    $orphan = Port-Holder $Port
    if ($orphan) {
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.ParentProcessId -eq $orphan } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Stop-Process -Id $orphan -Force -ErrorAction SilentlyContinue
      if (-not (Wait-PortFree $Port 10)) { throw "port $Port still held by PID $orphan after sweep" }
      Write-Host "  killed orphan PID $orphan + its Chromium children"
    }
  }

  Write-Host '== 4/5 start + save =='
  pm2 start ecosystem.config.cjs | Out-Null
  pm2 save | Out-Null
  if (-not (pm2 prettylist 2>$null | Select-String "name: '$App'")) { throw 'pm2 dump missing acolad-bot' }

  Write-Host '== 5/5 verify (<=90s) =='
  # Re-resolve the newest log each iteration: pino-roll's daily index is NOT monotonic with
  # time across restarts, and it may rotate mid-window - selecting once up front can watch a
  # stale file and false-FAIL a healthy deploy (which would invite a banned manual restart).
  $mark = (Get-Date)
  $ok = $false
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $log = Get-ChildItem "$root/logs/acolad.*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime | Select-Object -Last 1
    if ($log -and $log.LastWriteTime -gt $mark) {
      if (Get-Content $log.FullName -Tail 40 | Select-String '"action":"cycle","outcome":"ok"') {
        $ok = $true; break
      }
    }
    Start-Sleep -Seconds 3
  }
  $holder = Port-Holder $Port
  # Single-instance proof: the OS allows only one listener on $Port, so a held port already
  # rules out a second poller. Cross-check that PM2's one online acolad-bot IS that holder
  # (catches a started-but-failed-to-bind process). `pm2 pid` prints the PID(s) as plain
  # numbers - robust, unlike `pm2 jlist | ConvertFrom-Json` (PS5.1 chokes on the env block's
  # duplicate username/USERNAME keys) or a WMI main.js match (PM2's fork wrapper hides it).
  $pm2Pids = @((pm2 pid $App) | Where-Object { $_ -match '^\d+$' })
  if (-not $ok)     { throw 'FAIL: no fresh "poll cycle ok" within 90s' }
  if (-not $holder) { throw 'FAIL: lock port not held after start' }
  if ($pm2Pids.Count -ne 1 -or [int]$pm2Pids[0] -ne [int]$holder) {
    throw "FAIL: single-instance check - pm2 pids [$($pm2Pids -join ',')] != port holder $holder"
  }
  Write-Host "PASS: deployed, single instance (PID $holder holds port $Port), cycle ok" -ForegroundColor Green
}
finally {
  Pop-Location
}
