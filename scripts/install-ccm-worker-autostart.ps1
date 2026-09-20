[CmdletBinding()]
param(
    [string]$ConfigPath='',
    [string]$TaskName='CCM Remote Worker'
)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$supervisor=Join-Path $repoRoot 'scripts\ccm-worker-supervisor.ps1'
$vbs=Join-Path $stateDir 'ccm-worker-supervisor-hidden.vbs'

if(-not $ConfigPath){
    $ConfigPath=Join-Path $repoRoot 'config\worker.env'
}
if(-not [IO.Path]::IsPathRooted($ConfigPath)){
    $ConfigPath=Join-Path $repoRoot $ConfigPath
}

foreach($required in @($supervisor,$ConfigPath)){
    if(-not (Test-Path -LiteralPath $required)){
        throw "Missing required Worker file: $required"
    }
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$supervisorEscaped=$supervisor.Replace('"','""')
$configEscaped=$ConfigPath.Replace('"','""')
@"
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$supervisorEscaped"" -ConfigPath ""$configEscaped""", 0, True)
WScript.Quit rc
"@ | Set-Content -LiteralPath $vbs -Encoding ASCII

$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"' + $vbs + '"')
$currentUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$trigger.Delay='PT1M'
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output ("Installed scheduled task: {0}" -f $TaskName)
Write-Output ("Worker config: {0}" -f $ConfigPath)
