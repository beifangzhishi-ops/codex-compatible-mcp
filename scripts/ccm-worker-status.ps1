[CmdletBinding()]
param(
    [string]$ConfigPath='',
    [string]$TaskName='CCM Remote Worker'
)
$ErrorActionPreference='SilentlyContinue'
$repoRoot=Split-Path -Parent $PSScriptRoot
if(-not $ConfigPath){
    $ConfigPath=Join-Path $repoRoot 'config\worker.env'
}
if(-not [IO.Path]::IsPathRooted($ConfigPath)){
    $ConfigPath=Join-Path $repoRoot $ConfigPath
}

$values=@{}
if(Test-Path -LiteralPath $ConfigPath){
    foreach($rawLine in Get-Content -LiteralPath $ConfigPath){
        $line=[string]$rawLine
        $trimmed=$line.Trim()
        if(-not $trimmed -or $trimmed.StartsWith('#')){ continue }
        $equals=$line.IndexOf('=')
        if($equals -lt 1){ continue }
        $name=$line.Substring(0,$equals).Trim()
        $value=$line.Substring($equals+1).Trim()
        if($value.Length -ge 2){
            if(($value.StartsWith('"') -and $value.EndsWith('"')) -or
               ($value.StartsWith("'") -and $value.EndsWith("'"))){
                $value=$value.Substring(1,$value.Length-2)
            }
        }
        $values[$name]=$value
    }
}

$hostName=[string]$values['CCM_WORKER_HUB_CONNECT_HOST']
$port=[string]$values['CCM_WORKER_HUB_PORT']
if(-not $port){ $port='18301' }

Write-Output '=== CCM Remote Worker config ==='
Write-Output ("environment={0}" -f $values['CCM_ENVIRONMENT_ID'])
Write-Output ("worker={0}" -f $values['CCM_WORKER_ID'])
Write-Output ("workspace={0}" -f $values['CCM_WORKSPACE'])
Write-Output ("permission={0}" -f $values['CCM_PERMISSION_PROFILE'])
Write-Output ("controller={0}:{1}" -f $hostName,$port)

Write-Output '=== Controller reachability ==='
if($hostName){
    try {
        $reachable=Test-NetConnection -ComputerName $hostName -Port ([int]$port) -InformationLevel Quiet -WarningAction SilentlyContinue
        Write-Output ("worker hub reachable={0}" -f $reachable)
    } catch {
        Write-Output 'worker hub reachable=unknown'
    }
} else {
    Write-Output 'worker hub reachable=unknown (missing host)'
}

Write-Output '=== Scheduled task ==='
$task=Get-ScheduledTask -TaskName $TaskName
if($task){
    $info=Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Output ("{0}: {1}; last={2}; result={3}" -f $TaskName,$task.State,$info.LastRunTime,$info.LastTaskResult)
} else {
    Write-Output ("{0}: missing" -f $TaskName)
}

Write-Output '=== Worker process ==='
$pidFile=Join-Path $repoRoot '.state\ccm-worker.pid'
if(Test-Path $pidFile){
    $workerPid=[int](Get-Content -LiteralPath $pidFile -Raw)
    $proc=Get-Process -Id $workerPid -ErrorAction SilentlyContinue
    if($proc){ Write-Output ("worker pid={0}; running=true" -f $workerPid) }
    else { Write-Output ("worker pid={0}; running=false" -f $workerPid) }
} else {
    Write-Output 'worker pid file: missing'
}

Write-Output '=== Worker health ==='
$healthFile=Join-Path $repoRoot '.state\ccm-worker-health.json'
if(Test-Path -LiteralPath $healthFile){
    try {
        $health=Get-Content -LiteralPath $healthFile -Raw | ConvertFrom-Json
        Write-Output ("health pid={0}; state={1}; updated={2}; controller={3}:{4}" -f $health.pid,$health.state,$health.updated_at,$health.controller_host,$health.controller_port)
    } catch {
        Write-Output 'worker health: invalid'
    }
} else {
    Write-Output 'worker health: missing'
}

Write-Output '=== Recent supervisor log ==='
Get-Content (Join-Path $repoRoot 'logs\ccm-worker-supervisor.log') -Tail 15
