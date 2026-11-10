[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Controller','RemoteWorker')][string]$Role)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$taskName=if($Role -eq 'Controller'){'CCM Selfhost Gateway'}else{'CCM Remote Worker'}
$normalInstaller=if($Role -eq 'Controller'){
    Join-Path $root 'scripts\install-ccm-autostart.ps1'
}else{
    Join-Path $root 'scripts\install-ccm-worker-autostart.ps1'
}
$check=Join-Path $root 'scripts\check-ccm-admin-agent.mjs'
$switch=Join-Path $root 'scripts\switch-ccm-task-to-normal.ps1'
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$identity=New-Object System.Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'CCM task migration must be launched through the elevated administrator agent.'
}

& $node $check
if($LASTEXITCODE -ne 0){ throw 'Cannot switch privilege level without a verified elevated administrator agent.' }
& $normalInstaller
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if([string]$task.Principal.RunLevel -ne 'Limited'){
    throw "Scheduled task $taskName does not have Limited run level."
}

$switchName='CCM Privilege Switch'
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $switch + '" -Role ' + $Role + ' -SwitchTaskName "' + $switchName + '"'
$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 6) -StartWhenAvailable
$principal=New-ScheduledTaskPrincipal -UserId $task.Principal.UserId -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $switchName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $switchName
Write-Output "Administrator agent verified; $taskName saved Limited; independent switch task started."
