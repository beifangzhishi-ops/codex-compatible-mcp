$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 18444 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
tailscale funnel --remove /ccm-once | Out-Null
Write-Output 'CCM one-time test endpoint cleaned.'
