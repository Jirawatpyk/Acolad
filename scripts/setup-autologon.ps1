# One-time: enable Windows auto-logon so the dedicated bot box resurrects PM2 after a reboot
# WITHOUT a human logging in. Uses Sysinternals Autologon (stores the secret in the LSA, NOT
# plaintext registry). If Autologon.exe is absent, prints the manual steps and does nothing.
$ErrorActionPreference = 'Stop'

# PowerShell 5.1 has no null-conditional (?.) operator — resolve the path explicitly.
$cmd = Get-Command Autologon.exe -ErrorAction SilentlyContinue
if (-not $cmd) { $cmd = Get-Command Autologon64.exe -ErrorAction SilentlyContinue }
$autologon = if ($cmd) { $cmd.Source } else { $null }

if (-not $autologon) {
  Write-Host 'Sysinternals Autologon not found.' -ForegroundColor Yellow
  Write-Host 'Download: https://learn.microsoft.com/sysinternals/downloads/autologon'
  Write-Host 'Then run: Autologon.exe <username> <domain-or-.> <password>   (stores secret in LSA, not plaintext)'
  Write-Host 'Do NOT set HKLM\...\Winlogon\DefaultPassword by hand (plaintext).'
  exit 1
}

Write-Host "Found Autologon at $autologon"
Write-Host 'Run it interactively to enter the credential (it stores the secret in the LSA):'
Write-Host "  & `"$autologon`""
Write-Host ''
Write-Host 'After enabling auto-logon, confirm PM2 resurrect is wired:'
Write-Host '  pm2 save                 # capture the current process list (incl. acolad-bot)'
Write-Host '  pm2 status               # acolad-bot should be online'
Write-Host ''
Write-Host 'Reboot survival test: reboot the machine; the bot must come back WITHOUT logging in,'
Write-Host 'and the Healthchecks heartbeat must turn green within the 300s grace.'
