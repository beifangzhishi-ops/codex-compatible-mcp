[CmdletBinding()]
param(
    [ValidateSet('refresh','status')][string]$Mode='refresh',
    [string]$McpUrl='',
    [string]$CurrentName='CCM',
    [string]$OldName='CCM Old',
    [switch]$KeepWorkspaceVisible
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Resolve-BmgClient {
    if($env:CCM_BMG_CLIENT){
        if(Test-Path -LiteralPath $env:CCM_BMG_CLIENT){ return $env:CCM_BMG_CLIENT }
        $found=Get-Command $env:CCM_BMG_CLIENT -ErrorAction SilentlyContinue | Select-Object -First 1
        if($found){ return $found.Source }
    }
    foreach($name in @('bmgctl.cmd','bmgctl')){
        $found=Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if($found){ return $found.Source }
    }
    throw 'BMG is not installed or configured. Install Browser MCP Gateway and expose bmgctl on PATH or set CCM_BMG_CLIENT. Other CCM tools do not require BMG.'
}

function Resolve-McpUrl([string]$Value) {
    if($Value){ return $Value }
    if($env:CCM_RESOURCE){ return $env:CCM_RESOURCE }
    $repoRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $envFile=Join-Path $repoRoot 'config\ccm.env'
    if(Test-Path -LiteralPath $envFile){
        $line=Get-Content -LiteralPath $envFile |
            Where-Object { $_ -match '^CCM_RESOURCE=' } |
            Select-Object -First 1
        if($line){ return ($line -replace '^CCM_RESOURCE=','').Trim() }
    }
    throw 'MCP URL was not supplied and CCM_RESOURCE could not be resolved.'
}

$script:BmgClient=Resolve-BmgClient
$McpUrl=Resolve-McpUrl $McpUrl

function Invoke-Bmg([string]$Tool,[hashtable]$Arguments=@{}) {
    $json=$Arguments | ConvertTo-Json -Depth 20 -Compress
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $stdout=[IO.Path]::GetTempFileName()
    $stderr=[IO.Path]::GetTempFileName()
    try {
        $client='"' + $script:BmgClient.Replace('"','""') + '"'
        $command=$client + ' call ' + $Tool + ' --args-base64 ' + $encoded +
            ' 1>"' + $stdout + '" 2>"' + $stderr + '"'
        & cmd.exe /d /s /c $command | Out-Null
        $exit=$LASTEXITCODE
        $text=[IO.File]::ReadAllText($stdout,[Text.Encoding]::UTF8).Trim()
        $errorText=[IO.File]::ReadAllText($stderr,[Text.Encoding]::UTF8).Trim()
    } finally {
        Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
    }
    if($exit -ne 0){
        if($errorText){ throw "BMG tool $Tool failed: $errorText" }
        throw "BMG tool $Tool failed: $text"
    }
    $outer=$text | ConvertFrom-Json
    if(-not $outer.success){ throw "BMG tool $Tool failed: $text" }
    return $outer
}

function Unwrap-Bmg([object]$Outer) {
    $first=@($Outer.result.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1
    if(-not $first){ return $Outer.result }
    $level1=$first.text | ConvertFrom-Json
    if($level1.status -ne 'success'){ throw ('BMG upstream error: ' + $first.text) }
    if($null -ne $level1.data -and $level1.data.isError -eq $true){
        $detail=@($level1.data.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        $message=if($detail.Count){ [string]$detail[0].text } else { $first.text }
        throw ('BMG browser tool failed: ' + $message)
    }
    $second=@($level1.data.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1
    if(-not $second){ return $level1.data }
    try { return ($second.text | ConvertFrom-Json) } catch { return $second.text }
}

function Navigate([string]$Url) {
    [void](Invoke-Bmg 'chrome_navigate' @{url=$Url;newWindow=$false})
    Start-Sleep -Milliseconds 800
}

function Elements-Text([string]$Text) {
    return Unwrap-Bmg (Invoke-Bmg 'chrome_get_interactive_elements' @{
        textQuery=$Text
        includeCoordinates=$true
    })
}

function Elements-Selector([string]$Selector) {
    return Unwrap-Bmg (Invoke-Bmg 'chrome_get_interactive_elements' @{
        selector=$Selector
        includeCoordinates=$true
    })
}

function Click([string]$Selector,[bool]$WaitForNavigation=$false) {
    [void](Invoke-Bmg 'chrome_click_element' @{
        selector=$Selector
        waitForNavigation=$WaitForNavigation
    })
}

function Fill([string]$Selector,[string]$Value) {
    [void](Invoke-Bmg 'chrome_fill_or_select' @{selector=$Selector;value=$Value})
}

function Current-Tab {
    $data=Unwrap-Bmg (Invoke-Bmg 'get_windows_and_tabs' @{})
    foreach($window in @($data.windows)){
        foreach($tab in @($window.tabs)){
            if($tab.active){ return $tab }
        }
    }
    foreach($window in @($data.windows)){
        foreach($tab in @($window.tabs)){ return $tab }
    }
    return $null
}

function Page-Text {
    $value=Unwrap-Bmg (Invoke-Bmg 'chrome_get_web_content' @{textContent=$true})
    return [string]$value.textContent
}

function Connector-UiState {
    $text=Page-Text
    if($text -match '正在加载操作|Loading actions|Primary'){
        return 'connected'
    }
    $another=Find-ExactButton @('连接另一个账户','Connect another account')
    if($text -match '尚无可用的应用操作|No app actions available'){
        if($another){ return 'not_connected' }
    }
    if($null -ne (Find-ExactButton @('连接','Connect'))){
        return 'not_connected'
    }
    return 'unknown'
}

function Find-ExactButton([string[]]$Labels) {
    foreach($label in $Labels){
        $data=Elements-Text $label
        foreach($element in @($data.elements)){
            if($element.type -ne 'button'){ continue }
            if($Labels -contains ([string]$element.text).Trim()){ return $element }
        }
    }
    return $null
}

function Plugin-Settings {
    Navigate 'https://chatgpt.com/plugins#settings/Plugins'
}

function Find-Installed([string]$Name) {
    $data=Elements-Text $Name
    foreach($element in @($data.elements)){
        if($element.type -notin @('button','link')){ continue }
        $text=([string]$element.text).Trim()
        if($text -eq $Name -or
           $text -eq ($Name + '全部允许') -or
           $text -eq ($Name + 'Allow all')){
            return $element
        }
    }
    return $null
}

function Rename-Connector([object]$Connector,[string]$NewName) {
    Click $Connector.selector
    Start-Sleep -Milliseconds 600
    $actions=$null
    foreach($label in @('插件操作','Plugin actions')){
        $candidate=Find-ExactButton @($label)
        if($candidate){ $actions=$candidate; break }
    }
    if(-not $actions){ throw 'Could not locate the plugin actions menu.' }
    [void](Invoke-Bmg 'chrome_keyboard' @{selector=$actions.selector;keys='Enter'})
    Start-Sleep -Milliseconds 250
    $menu=Elements-Selector '[role="menuitem"]'
    $edit=@($menu.elements | Where-Object {
        ([string]$_.text).Trim() -in @('编辑名称','Edit name')
    }) | Select-Object -First 1
    if(-not $edit){ throw 'Could not locate Edit name in the plugin actions menu.' }
    Click $edit.selector
    Start-Sleep -Milliseconds 250
    Fill '#connector-name' $NewName
    $save=Find-ExactButton @('保存','Save')
    if(-not $save){ throw 'Could not locate Save while renaming the connector.' }
    Click $save.selector
    Start-Sleep -Milliseconds 700
}

function Create-Connector {
    Navigate 'https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins'
    Start-Sleep -Milliseconds 500
    Fill '#custom-connector-name' $CurrentName
    try { Click '#custom-connector-url' } catch {}
    Fill '#custom-connector-url' $McpUrl
    Start-Sleep -Seconds 3
    $trust=Elements-Selector '#trust-checkbox'
    $checkbox=@($trust.elements) | Select-Object -First 1
    if(-not $checkbox){ throw 'Could not locate the MCP trust confirmation checkbox.' }
    Click $checkbox.selector
    Start-Sleep -Milliseconds 250
    $create=Find-ExactButton @('创建','Create')
    if(-not $create){ throw 'Could not locate Create after MCP/OAuth discovery.' }
    Click $create.selector
    Start-Sleep -Seconds 2
}

function Start-Connection([object]$Connector) {
    Click $Connector.selector
    Start-Sleep -Milliseconds 700
    $state=Connector-UiState
    if($state -eq 'connected'){ return 'ui_connected' }
    if($state -eq 'unknown'){ return 'unknown' }
    [void](Invoke-Bmg 'bmg_show_workspace' @{})
    return 'manual_connection_required'
}

function Emit([string]$State,[hashtable]$Extra=@{}) {
    $value=[ordered]@{
        success=($State -notin @('error','missing_registration'))
        state=$State
        current_name=$CurrentName
        old_name=$OldName
        mcp_url=$McpUrl
        old_connector_deleted=$false
        complete=$false
    }
    foreach($key in $Extra.Keys){ $value[$key]=$Extra[$key] }
    $value | ConvertTo-Json -Depth 12 -Compress
}

Plugin-Settings
$current=Find-Installed $CurrentName
$old=Find-Installed $OldName

if($Mode -eq 'status'){
    $ui='unknown'
    if($current){
        Click $current.selector
        Start-Sleep -Milliseconds 500
        $ui=Connector-UiState
    }
    Emit 'status' @{
        current_present=($null -ne $current)
        old_present=($null -ne $old)
        ui_connection_state=$ui
        host_verification_required=$true
    }
    exit 0
}

if($current -and -not $old){
    Rename-Connector $current $OldName
    Plugin-Settings
    $old=Find-Installed $OldName
    if(-not $old){ throw "Rename verification failed: '$OldName' was not found." }
    $current=$null
}

if(-not $current -and $old){
    Create-Connector
    $tab=Current-Tab
    if($tab -and ([string]$tab.url) -match '/oauth/consent'){
        [void](Invoke-Bmg 'bmg_show_workspace' @{})
        Emit 'authorization_required' @{
            current_present=$false
            old_present=$true
            host_verification_required=$true
            message='Fresh CCM registration was created. Complete OAuth in the visible BMG workspace, then run this tool again.'
        }
        exit 0
    }
    Plugin-Settings
    $current=Find-Installed $CurrentName
}

if(-not $current -and -not $old){
    Emit 'missing_registration' @{
        current_present=$false
        old_present=$false
        host_verification_required=$true
        message='Neither connector exists. Refusing to create a fresh CCM without an old registration to preserve.'
    }
    exit 1
}

if(-not $current){
    Emit 'creation_pending' @{
        current_present=$false
        old_present=($null -ne $old)
        host_verification_required=$true
        message='Fresh CCM creation has not become visible yet. Run this tool again to resume.'
    }
    exit 0
}

$connection=Start-Connection $current
if($connection -eq 'authorization_required'){
    Emit 'authorization_required' @{
        current_present=$true
        old_present=($null -ne $old)
        host_verification_required=$true
        message='OAuth consent is waiting in the visible BMG workspace. Complete it, then run this tool again.'
    }
    exit 0
}
if($connection -in @('manual_connection_required','unknown')){
    Emit 'connection_required' @{
        current_present=$true
        old_present=($null -ne $old)
        ui_connection_state=$connection
        host_verification_required=$true
        message='The fresh connector is not connected yet. The BMG workspace has been shown for the required trusted Connect/OAuth interaction. Complete the connection, then run this tool again. Do not treat CCM Old tool availability as proof for the fresh CCM.'
    }
    exit 0
}

if(-not $KeepWorkspaceVisible){ [void](Invoke-Bmg 'bmg_hide_workspace' @{}) }
Emit 'host_verification_required' @{
    current_present=$true
    old_present=($null -ne $old)
    ui_connection_state=$connection
    host_verification_required=$true
    message='ChatGPT UI reports a connected account for the fresh CCM. Final success still requires the host ChatGPT session to expose the fresh CCM namespace/app instance and successfully execute a read-only tool from it. CCM Old availability does not count.'
}
