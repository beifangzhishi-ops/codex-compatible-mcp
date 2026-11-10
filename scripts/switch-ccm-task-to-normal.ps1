[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Controller','RemoteWorker')][string]$Role,
    [string]$SwitchTaskName='CCM Privilege Switch'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$log=Join-Path $root 'logs\ccm-privilege-switch.log'
$taskName=if($Role -eq 'Controller'){'CCM Selfhost Gateway'}else{'CCM Remote Worker'}
$healthyFile=Join-Path $root '.state\ccm-worker-health.json'
$pidFile=if($Role -eq 'Controller'){
    Join-Path $root '.state\ccm-public.pid'
}else{
    Join-Path $root '.state\ccm-worker.pid'
}
$previousPid=if(Test-Path -LiteralPath $pidFile){
    [string](Get-Content -LiteralPath $pidFile -Raw).Trim()
}else{''}
$switchStart=[DateTimeOffset]::Now
function Log([string]$message){
    ('[{0}] {1}' -f (Get-Date -Format s),$message) | Out-File -LiteralPath $log -Append -Encoding UTF8
}
function Healthy {
    try {
        if(-not (Test-Path -LiteralPath $pidFile)){ return $false }
        $currentPid=[string](Get-Content -LiteralPath $pidFile -Raw).Trim()
        if(-not $currentPid -or $currentPid -eq $previousPid){ return $false }
        if($Role -eq 'Controller'){
            $controller=Invoke-RestMethod 'http://127.0.0.1:18209/ccm/health' -TimeoutSec 2
            $sidecar=Invoke-RestMethod 'http://127.0.0.1:18208/health' -TimeoutSec 2
            return $controller.status -eq 'ok' -and $sidecar.status -eq 'ok'
        }
        if(-not (Test-Path -LiteralPath $healthyFile)){ return $false }
        $state=Get-Content -LiteralPath $healthyFile -Raw | ConvertFrom-Json
        $timestamp=[DateTimeOffset]::Parse([string]$state.updated_at)
        return $state.state -eq 'connected' -and $timestamp -gt $switchStart -and
            ([DateTimeOffset]::Now-$timestamp).TotalSeconds -lt 15
    } catch { return $false }
}

try {
    # The elevated switch is a distinct Task Scheduler process, so stopping the
    # old Supervisor cannot cancel the process responsible for restarting it.
    Start-Sleep -Seconds 8
    Log "stopping $taskName before Limited restart"
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Start-Sleep -Seconds 6
    Log "starting $taskName with Limited principal"
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $ok=$false
    for($i=0;$i -lt 60;$i++){
        if(Healthy){ $ok=$true; break }
        Start-Sleep -Seconds 2
    }
    if(-not $ok){ throw 'Limited-principal CCM health verification timed out.' }
    Log "verified Limited-principal $taskName healthy"
} catch {
    Log ('switch failed: ' + $_.Exception.Message)
    try {
        # Failure recovery only: restore the existing service immediately.
        $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $qualifiedUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal=New-ScheduledTaskPrincipal -UserId $qualifiedUser -LogonType Interactive -RunLevel Highest
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Set-ScheduledTask -TaskName $taskName -Principal $principal -ErrorAction Stop | Out-Null
        Start-Sleep -Seconds 4
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        Log "restored $taskName to highest run level after failed switch"
    } catch { Log ('recovery failed: ' + $_.Exception.Message) }
} finally {
    try { Unregister-ScheduledTask -TaskName $SwitchTaskName -Confirm:$false -ErrorAction Stop } catch {
        Log ('cannot clean temporary switch task: ' + $_.Exception.Message)
    }
}
