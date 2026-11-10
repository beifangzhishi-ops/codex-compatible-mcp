[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$agent=Join-Path $repoRoot 'src\admin\agent.mjs'
$log=Join-Path $repoRoot 'logs\ccm-admin-agent.log'
if(-not (Test-Path -LiteralPath $agent)){ throw "Missing administrator agent: $agent" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
& $node $agent 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
exit $LASTEXITCODE
