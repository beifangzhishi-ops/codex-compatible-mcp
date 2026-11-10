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
$adminInstaller=Join-Path $root 'scripts\install-ccm-admin-agent.ps1'
$build=Join-Path $root 'scripts\build-native.mjs'
$check=Join-Path $root 'scripts\check-ccm-admin-agent.mjs'
$switch=Join-Path $root 'scripts\switch-ccm-task-to-normal.ps1'
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$identity=New-Object System.Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'This one-time CCM deployment must run from an elevated Windows token.'
}

# Do not reconfigure a live scheduled task until both the native build and
# independent elevated agent are available and verified.
& $node $build
if($LASTEXITCODE -ne 0){ throw 'Native build failed. Existing Task Scheduler configuration was not modified.' }
& $adminInstaller
$ok=$false
for($i=0;$i -lt 20;$i++){
    & $node $check 2>$null
    if($LASTEXITCODE -eq 0){ $ok=$true; break }
    Start-Sleep -Seconds 1
}
if(-not $ok){ throw 'Administrator agent failed elevated IPC verification. Ordinary tasks were not modified.' }

& $normalInstaller
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if([string]$task.Principal.RunLevel -ne 'Limited'){
    throw "Scheduled task $taskName does not have Limited run level."
}

# The switch task is independently supervised by Windows and survives the
# deliberate shutdown of the old elevated CCM Supervisor.
$switchName='CCM Privilege Switch'
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $switch + '" -Role ' + $Role + ' -SwitchTaskName "' + $switchName + '"'
$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 6) -StartWhenAvailable
$principal=New-ScheduledTaskPrincipal -UserId $task.Principal.UserId -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $switchName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $switchName
Write-Output "Admin agent verified; $taskName registered Limited; independent switch task started."
