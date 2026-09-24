[CmdletBinding()]
param()
$ErrorActionPreference='SilentlyContinue'
$repoRoot=Split-Path -Parent $PSScriptRoot

Write-Output '=== CCM local ==='
Get-NetTCPConnection -State Listen -LocalPort 18208,18209,18301 |
    Select-Object LocalAddress,LocalPort,OwningProcess |
    Sort-Object LocalPort |
    Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== Controller ==='
try {
    $health=Invoke-RestMethod 'http://127.0.0.1:18209/ccm/health' -TimeoutSec 3
    Write-Output ("controller: {0}; default={1}" -f $health.status,$health.default_environment_id)
    @($health.environments) | ForEach-Object {
        $state=if($_.state){$_.state}else{'normal'}
        $detail=if($_.abnormal_reason){"; reason=" + $_.abnormal_reason}else{''}
        Write-Output ("{0}: backend={1}; state={2}{3}" -f $_.id,$_.backend,$state,$detail)
    }
} catch { Write-Output 'controller health: unavailable' }

Write-Output '=== OAuth sidecar ==='
try {
    $side=Invoke-RestMethod 'http://127.0.0.1:18208/health' -TimeoutSec 3
    Write-Output ("sidecar: {0}; issuer={1}" -f $side.status,$side.issuer)
} catch { Write-Output 'sidecar health: unavailable' }

Write-Output '=== Scheduled task ==='
$task=Get-ScheduledTask -TaskName 'CCM Selfhost Gateway'
if($task){
    $info=Get-ScheduledTaskInfo -TaskName 'CCM Selfhost Gateway'
    Write-Output ("CCM Selfhost Gateway: {0}; last={1}; result={2}" -f $task.State,$info.LastRunTime,$info.LastTaskResult)
} else {
    Write-Output 'CCM Selfhost Gateway: missing'
}

Write-Output '=== User deployment profile ==='
$profile=[Environment]::GetEnvironmentVariable('CCM_PERMISSION_PROFILE','User')
Write-Output ("CCM_PERMISSION_PROFILE={0}" -f $profile)

Write-Output '=== Recent supervisor log ==='
Get-Content (Join-Path $repoRoot 'logs\ccm-supervisor.log') -Tail 15
