param(
  [Parameter(Mandatory=$true)][string]$DirectoryFilePath,
  [Parameter(Mandatory=$true)][string]$FilenameFilePath,
  [int]$TtlSeconds = 300
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$secret = & (Join-Path $PSScriptRoot 'resolve-target.ps1') -DirectoryFilePath $DirectoryFilePath -FilenameFilePath $FilenameFilePath
if (-not $secret -or @($secret).Count -ne 1) {
  throw 'Target text file could not be resolved.'
}
$secret = [string]$secret

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = [Convert]::ToBase64String($bytes).Replace('/','_').Replace('+','-').TrimEnd('=')
$node = (Get-Command node.exe -ErrorAction Stop).Source

Get-NetTCPConnection -LocalPort 18444 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$process = Start-Process -FilePath $node -ArgumentList @(
  (Join-Path $PSScriptRoot 'server.cjs'), $token, $secret, [string]$TtlSeconds
) -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 500
if ($process.HasExited) { throw 'One-time secret server failed to start.' }

tailscale funnel --bg --set-path /ccm-once http://127.0.0.1:18444 | Out-Null
$issuer = Get-Content -LiteralPath (Join-Path $root 'config\ccm.env') |
  Where-Object { $_ -match '^CCM_ISSUER=' } | Select-Object -First 1
if (-not $issuer) { throw 'CCM_ISSUER is unavailable.' }
$origin = (($issuer -replace '^CCM_ISSUER=','').Trim() -replace '/ccm$','')
Write-Output ($origin + '/ccm-once/' + $token)
