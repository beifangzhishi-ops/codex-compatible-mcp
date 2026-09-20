[CmdletBinding()]
param(
    [string]$ConfigPath=''
)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$logDir=Join-Path $repoRoot 'logs'
$workerScript=Join-Path $repoRoot 'src\worker\agent.mjs'
$buildScript=Join-Path $repoRoot 'scripts\build-native.mjs'
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$supervisorLog=Join-Path $logDir 'ccm-worker-supervisor.log'

if(-not $ConfigPath){
    $ConfigPath=Join-Path $repoRoot 'config\worker.env'
}
if(-not [IO.Path]::IsPathRooted($ConfigPath)){
    $ConfigPath=Join-Path $repoRoot $ConfigPath
}

New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null
foreach($required in @($workerScript,$buildScript,$ConfigPath)){
    if(-not (Test-Path -LiteralPath $required)){
        throw "Missing required Worker file: $required"
    }
}

function Import-WorkerEnv([string]$path){
    foreach($rawLine in Get-Content -LiteralPath $path){
        $line=[string]$rawLine
        $trimmed=$line.Trim()
        if(-not $trimmed -or $trimmed.StartsWith('#')){ continue }
        $equals=$line.IndexOf('=')
        if($equals -lt 1){ throw "Invalid worker.env line: $line" }
        $name=$line.Substring(0,$equals).Trim()
        $value=$line.Substring($equals+1).Trim()
        if($value.Length -ge 2){
            if(($value.StartsWith('"') -and $value.EndsWith('"')) -or
               ($value.StartsWith("'") -and $value.EndsWith("'"))){
                $value=$value.Substring(1,$value.Length-2)
            }
        }
        if($name -notmatch '^CCM_[A-Z0-9_]+$'){
            throw "Unsupported worker.env variable: $name"
        }
        [Environment]::SetEnvironmentVariable($name,$value,'Process')
    }
}

Import-WorkerEnv $ConfigPath

if(-not $env:CCM_WORKER_HUB_CONNECT_HOST){
    throw 'CCM_WORKER_HUB_CONNECT_HOST is required in config\worker.env.'
}
if(-not $env:CCM_WORKSPACE){
    throw 'CCM_WORKSPACE is required in config\worker.env.'
}
if(-not (Test-Path -LiteralPath $env:CCM_WORKSPACE)){
    throw "CCM_WORKSPACE does not exist: $($env:CCM_WORKSPACE)"
}
$allowedProfiles=@('read-only','workspace-write','full-access')
if($env:CCM_PERMISSION_PROFILE -and
   $allowedProfiles -notcontains $env:CCM_PERMISSION_PROFILE){
    throw 'CCM_PERMISSION_PROFILE must be read-only, workspace-write, or full-access.'
}

& $node $buildScript
if($LASTEXITCODE -ne 0){ throw 'CCM native build failed.' }

$identity=if($env:CCM_WORKER_ID){$env:CCM_WORKER_ID}
    elseif($env:CCM_ENVIRONMENT_ID){$env:CCM_ENVIRONMENT_ID}
    else{$env:COMPUTERNAME}
$mutexName='Global\CcmRemoteWorker-' + ($identity -replace '[^A-Za-z0-9_.-]','_')
$createdNew=$false
$mutex=New-Object System.Threading.Mutex($true,$mutexName,[ref]$createdNew)
if(-not $createdNew){ $mutex.Dispose(); exit 0 }
$selfInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$launcherPid=[int]$selfInfo.ParentProcessId
$launcherInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$launcherPid" -ErrorAction SilentlyContinue
$watchLauncher=$null -ne $launcherInfo -and $launcherInfo.Name -ieq 'wscript.exe'

function LauncherAlive {
    if(-not $watchLauncher){ return $true }
    return $null -ne (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)
}
function Log([string]$message){
    "[$(Get-Date -Format s)] $message" |
        Out-File $supervisorLog -Encoding utf8 -Append
}
function StartHidden([string]$file,[string]$arguments){
    $psi=New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName=$file
    $psi.Arguments=$arguments
    $psi.WorkingDirectory=$repoRoot
    $psi.UseShellExecute=$false
    $psi.CreateNoWindow=$true
    $proc=New-Object System.Diagnostics.Process
    $proc.StartInfo=$psi
    if(-not $proc.Start()){ throw "Failed to start $file" }
    return $proc
}
function StopTree($proc){
    if($null -ne $proc -and -not $proc.HasExited){
        & taskkill.exe /PID $proc.Id /T /F *> $null
    }
}

$workerPidFile=Join-Path $stateDir 'ccm-worker.pid'
try {
    while($true){
        if(-not (LauncherAlive)){ return }
        $worker=$null
        try {
            $quotedWorker='"' + $workerScript + '"'
            $worker=StartHidden $node $quotedWorker
            Set-Content $workerPidFile $worker.Id -Encoding ASCII
            Log (
                "started worker={0} environment={1} controller={2}:{3} permission={4}" -f
                $worker.Id,
                $(if($env:CCM_ENVIRONMENT_ID){$env:CCM_ENVIRONMENT_ID}else{$env:COMPUTERNAME}),
                $env:CCM_WORKER_HUB_CONNECT_HOST,
                $(if($env:CCM_WORKER_HUB_PORT){$env:CCM_WORKER_HUB_PORT}else{'18301'}),
                $(if($env:CCM_PERMISSION_PROFILE){$env:CCM_PERMISSION_PROFILE}else{'workspace-write'})
            )

            while(-not $worker.HasExited){
                if(-not (LauncherAlive)){
                    Log 'scheduled-task launcher exited'
                    return
                }
                Start-Sleep -Seconds 2
            }
            Log ("worker exited code={0}; restarting in 5 seconds" -f $worker.ExitCode)
        } catch {
            Log ('error: ' + $_.Exception.Message)
        } finally {
            StopTree $worker
            Remove-Item $workerPidFile -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 5
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
