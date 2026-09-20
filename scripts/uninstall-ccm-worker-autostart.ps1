[CmdletBinding()]
param(
    [string]$TaskName='CCM Remote Worker'
)
$ErrorActionPreference='SilentlyContinue'
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
$repoRoot=Split-Path -Parent $PSScriptRoot
Remove-Item (Join-Path $repoRoot '.state\ccm-worker-supervisor-hidden.vbs') -Force
Write-Output ("Removed scheduled task: {0}" -f $TaskName)
