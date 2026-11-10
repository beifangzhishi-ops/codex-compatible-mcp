[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Controller','RemoteWorker')][string]$Role)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$adminInstaller=Join-Path $root 'scripts\install-ccm-admin-agent.ps1'
$build=Join-Path $root 'scripts\build-native.mjs'
$check=Join-Path $root 'scripts\check-ccm-admin-agent.mjs'
$complete=Join-Path $root 'scripts\complete-ccm-privilege-split.ps1'
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
& $complete -Role $Role
