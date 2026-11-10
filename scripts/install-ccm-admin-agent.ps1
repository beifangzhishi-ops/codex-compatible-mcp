[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$agentScript=Join-Path $repoRoot 'scripts\ccm-admin-agent.ps1'
$key=Join-Path $stateDir 'admin-agent.key'
$vbs=Join-Path $stateDir 'ccm-admin-agent-hidden.vbs'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principalCheck=New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Install the CCM administrator task once from an elevated PowerShell.'
}
if(-not (Test-Path -LiteralPath $agentScript)){ throw "Missing administrator agent script: $agentScript" }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if(-not (Test-Path -LiteralPath $key)){
    $node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $randomKey=& $node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
    if($LASTEXITCODE -ne 0 -or $randomKey -notmatch '^[a-f0-9]{64}$'){
        throw 'Unable to initialize administrator IPC authentication key.'
    }
    Set-Content -LiteralPath $key -Value $randomKey -NoNewline -Encoding ASCII
}
& "$env:WINDIR\System32\icacls.exe" $key /inheritance:r /grant:r "${user}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if($LASTEXITCODE -ne 0){ throw 'Unable to secure administrator IPC authentication key.' }
$escaped=$agentScript.Replace('"','""')
@"
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$escaped""", 0, True)
WScript.Quit rc
"@ | Set-Content -LiteralPath $vbs -Encoding ASCII
$action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"' + $vbs + '"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 30 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'CCM Administrator Agent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'CCM Administrator Agent'
Write-Output 'CCM Administrator Agent task installed and start requested.'
