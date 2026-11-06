[CmdletBinding()]
param(
    [string]$PublicBaseUrl=''
)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$example=Join-Path $repoRoot 'ccm.config.example.json'
$config=Join-Path $repoRoot 'ccm.config.json'
$stateDir=Join-Path $repoRoot '.state'
$secretFile=Join-Path $stateDir 'ccm-approval-secret.txt'
$utf8=New-Object Text.UTF8Encoding($false)

function NewRandomToken {
    $bytes=New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if(-not (Test-Path -LiteralPath $config)){
    Copy-Item -LiteralPath $example -Destination $config
}

$configData=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
if($configData.version -ne 1 -or -not $configData.controller -or -not $configData.controller.env){
    throw 'Invalid root CCM configuration.'
}
if($PublicBaseUrl){
    try { $baseUri=[Uri]$PublicBaseUrl } catch { throw 'PublicBaseUrl must be an absolute HTTPS origin.' }
    if(-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'https' -or
       $baseUri.AbsolutePath -ne '/' -or $baseUri.UserInfo -or
       $baseUri.Query -or $baseUri.Fragment){
        throw 'PublicBaseUrl must be a clean HTTPS origin, for example https://host.example.'
    }
    $base=$PublicBaseUrl.TrimEnd('/')
    $configData.controller.env.CCM_ISSUER="$base/ccm"
    $configData.controller.env.CCM_RESOURCE="$base/ccm/mcp"
    [IO.File]::WriteAllText($config,($configData | ConvertTo-Json -Depth 40),$utf8)
}

if([string]$configData.controller.env.CCM_RESOURCE -match '(example\.invalid|your-machine\.your-tailnet\.ts\.net)'){
    throw 'Set the public hostname in ccm.config.json or rerun with -PublicBaseUrl.'
}

if(-not (Test-Path -LiteralPath $secretFile)){
    [IO.File]::WriteAllText(
        $secretFile,
        (NewRandomToken)+"`n",
        [Text.Encoding]::ASCII
    )
}

Write-Output 'CCM OAuth configuration is ready.'
Write-Output ('OAuth config: ' + $config)
Write-Output ('Approval secret: ' + $secretFile + ' (local-only; do not publish)')
