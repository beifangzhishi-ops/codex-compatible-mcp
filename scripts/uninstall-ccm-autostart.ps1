[CmdletBinding()]
param()
$ErrorActionPreference='SilentlyContinue'
Stop-ScheduledTask -TaskName 'CCM Selfhost Gateway'
Unregister-ScheduledTask -TaskName 'CCM Selfhost Gateway' -Confirm:$false
$repoRoot=Split-Path -Parent $PSScriptRoot
Remove-Item (Join-Path $repoRoot '.state\ccm-supervisor-hidden.vbs') -Force
Write-Output 'Removed scheduled task: CCM Selfhost Gateway'
