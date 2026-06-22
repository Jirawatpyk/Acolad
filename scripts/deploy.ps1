# One-command, single-instance-safe deploy. NEVER `pm2 restart` by hand — always this.
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
  # PS 5.1: $? is unreliable for native exe exit codes — gate on $LASTEXITCODE so a tsc
  # error aborts here instead of redeploying a stale/broken dist/.
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  Write-Host '== 2/5 stop + wait for port free =='
  pm2 stop $App | Out-Null
  if (-not (Wait-PortFree $Port 45)) {
    # 3/5 orphan sweep — the lock port is acolad's signature, so the holder IS an orphan.
    Write-Host '== 3/5 orphan still holds the lock port — sweeping =='
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
  # time across restarts, and it may rotate mid-window — selecting once up front can watch a
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
  # Assert exactly ONE acolad poller — catches an orphaned main.js that survived the sweep
  # (verify by port-held + cycle-ok alone would FALSE-PASS with a second instance running).
  $instances = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]runtime[\\/]main\.js' })
  if (-not $ok)                  { throw 'FAIL: no fresh "poll cycle ok" within 90s' }
  if (-not $holder)              { throw 'FAIL: lock port not held after start' }
  if ($instances.Count -ne 1)   { throw "FAIL: expected exactly 1 acolad main.js process, found $($instances.Count)" }
  Write-Host "PASS: deployed, single instance (PID $holder holds port $Port), cycle ok" -ForegroundColor Green
}
finally {
  Pop-Location
}
