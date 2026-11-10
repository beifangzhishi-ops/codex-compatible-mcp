[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$agentScript=Join-Path $repoRoot 'scripts\ccm-admin-agent.ps1'
$agentModule=Join-Path $repoRoot 'src\admin\agent.mjs'
$checkScript=Join-Path $repoRoot 'scripts\check-ccm-admin-agent.mjs'
$key=Join-Path $stateDir 'admin-agent.key'
$endpoint=Join-Path $stateDir 'admin-agent-endpoint.json'
$vbs=Join-Path $stateDir 'ccm-admin-agent-hidden.vbs'
$taskName='CCM Administrator Agent'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principalCheck=New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Install the CCM administrator task once from an elevated PowerShell.'
}
if(-not (Test-Path -LiteralPath $agentScript)){ throw "Missing administrator agent script: $agentScript" }
if(-not (Test-Path -LiteralPath $agentModule)){ throw "Missing administrator agent module: $agentModule" }
if(-not (Test-Path -LiteralPath $checkScript)){ throw "Missing administrator agent probe: $checkScript" }
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if(-not (Test-Path -LiteralPath $key)){
    $randomKey=& $node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
    if($LASTEXITCODE -ne 0 -or $randomKey -notmatch '^[a-f0-9]{64}$'){
        throw 'Unable to initialize administrator IPC authentication key.'
    }
    Set-Content -LiteralPath $key -Value $randomKey -NoNewline -Encoding ASCII
}
& "$env:WINDIR\System32\icacls.exe" $key /inheritance:r /grant:r "${user}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if($LASTEXITCODE -ne 0){ throw 'Unable to secure administrator IPC authentication key.' }

# Updating the scheduled task definition does not terminate an existing
# elevated Node child. Stop the old task first, then clean up only agent
# processes whose command line points to this installation's exact module.
$prior=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($prior -and $prior.State -eq 'Running'){
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $stopped=$false
    for($i=0;$i -lt 45;$i++){
        $current=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if($current.State -ne 'Running'){$stopped=$true;break}
        Start-Sleep -Seconds 1
    }
    if(-not $stopped){throw "Old $taskName task did not stop."}
}
$agentModule=[System.IO.Path]::GetFullPath($agentModule)
$leftovers=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object {
        $command=[string]$_.CommandLine
        $command.IndexOf($agentModule,[System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
foreach($process in $leftovers){
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}
# The new listener must publish its own fresh port, never reuse stale metadata.
if(Test-Path -LiteralPath $endpoint){Remove-Item -LiteralPath $endpoint -Force -ErrorAction Stop}

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
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
$verified=$false
for($i=0;$i -lt 30;$i++){
    if(Test-Path -LiteralPath $endpoint){
        try {
            & $node $checkScript 2>&1 | Out-Null
            if($LASTEXITCODE -eq 0){$verified=$true;break}
        } catch {
            # The listener may not yet have completed startup.
        }
    }
    Start-Sleep -Seconds 1
}
if(-not $verified){throw 'CCM Administrator Agent task did not provide verified elevated IPC after restart.'}
Write-Output 'CCM Administrator Agent task installed and elevated IPC verified.'
