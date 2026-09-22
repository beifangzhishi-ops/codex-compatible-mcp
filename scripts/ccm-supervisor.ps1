[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $repoRoot '.state'
$logDir=Join-Path $repoRoot 'logs'
$publicScript=Join-Path $repoRoot 'scripts\start-public.mjs'
$buildScript=Join-Path $repoRoot 'scripts\build-native.mjs'
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$supervisorLog=Join-Path $logDir 'ccm-supervisor.log'
New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null
foreach($required in @($publicScript,$buildScript)){
    if(-not (Test-Path $required)){ throw "Missing runtime file: $required" }
}
& $node $buildScript
if($LASTEXITCODE -ne 0){ throw 'CCM native build failed.' }

$profile=[Environment]::GetEnvironmentVariable('CCM_PERMISSION_PROFILE','User')
if($profile){ $env:CCM_PERMISSION_PROFILE=$profile }

$createdNew=$false
$mutex=New-Object System.Threading.Mutex($true,'Global\CcmSelfhostGateway',[ref]$createdNew)
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
    "[$(Get-Date -Format s)] $message" | Out-File $supervisorLog -Encoding utf8 -Append
}
function Listener([int]$port){
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } |
        Select-Object -First 1
}
function WaitPort([int]$port,[int]$seconds){
    for($i=0;$i -lt ($seconds*4);$i++){
        if(Listener $port){ return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
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
function WaitHealthy([int]$seconds){
    for($i=0;$i -lt ($seconds*2);$i++){
        try {
            $health=Invoke-RestMethod 'http://127.0.0.1:18209/ccm/health' -TimeoutSec 2
            $side=Invoke-RestMethod 'http://127.0.0.1:18208/health' -TimeoutSec 2
            if($health.status -eq 'ok' -and $side.status -eq 'ok'){
                return $true
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

try {
    while($true){
        if(-not (LauncherAlive)){ return }
        $gateway=$null
        try {
            foreach($port in @(18208,18209,18301)){
                if(Listener $port){ throw "Port $port is already in use; refusing to claim it." }
            }

            $quotedPublicScript='"' + $publicScript + '"'
            $gateway=StartHidden $node $quotedPublicScript
            Set-Content (Join-Path $stateDir 'ccm-public.pid') $gateway.Id -Encoding ASCII

            if(-not (WaitPort 18209 20)){ throw 'CCM Controller did not listen on 18209.' }
            if(-not (WaitPort 18301 10)){ throw 'CCM WorkerHub did not listen on 18301.' }
            if(-not (WaitPort 18208 10)){ throw 'CCM OAuth sidecar did not listen on 18208.' }
            if(-not (WaitHealthy 20)){ throw 'CCM health checks did not become ready.' }

            $health=(Invoke-RestMethod 'http://127.0.0.1:18209/ccm/health' -TimeoutSec 3)
            $expectedEnv=if($env:CCM_ENVIRONMENT_ID){$env:CCM_ENVIRONMENT_ID}else{$env:COMPUTERNAME}
            $envInfo=$health.environments |
                Where-Object { $_.id -eq $expectedEnv } |
                Select-Object -First 1
            if(-not $envInfo){
                $envInfo=$health.environments | Select-Object -First 1
            }
            Log ("ready gateway={0} env={1} permission={2}" -f $gateway.Id,$envInfo.id,$envInfo.permission_profile)

            while(-not $gateway.HasExited){
                if(-not (LauncherAlive)){
                    Log 'scheduled-task launcher exited'
                    return
                }
                Start-Sleep -Seconds 2
            }
            Log ("gateway exited code={0}" -f $gateway.ExitCode)
        } catch {
            Log ('error: ' + $_.Exception.Message)
        } finally {
            StopTree $gateway
            Remove-Item (Join-Path $stateDir 'ccm-public.pid') -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 10
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
