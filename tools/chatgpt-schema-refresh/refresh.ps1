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

function Resolve-CcmRoot {
    return Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function ConvertFrom-CcmEnvValue([string]$Value) {
    $text=$Value.Trim()
    if($text.Length -lt 2){ return $text }
    if($text.StartsWith('"') -and $text.EndsWith('"')){
        try { return [string]($text | ConvertFrom-Json) } catch { return $text.Substring(1,$text.Length-2) }
    }
    if($text.StartsWith("'") -and $text.EndsWith("'")){
        return $text.Substring(1,$text.Length-2)
    }
    return $text
}

function Resolve-CcmConfigValue([string]$Name,[string]$Default='') {
    $environmentValue=[Environment]::GetEnvironmentVariable($Name)
    if($environmentValue){ return $environmentValue }
    $repoRoot=Resolve-CcmRoot
    $envFile=Join-Path $repoRoot 'config\ccm.env'
    if(Test-Path -LiteralPath $envFile){
        $pattern='^' + [regex]::Escape($Name) + '\s*='
        $line=Get-Content -LiteralPath $envFile |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -match $pattern } |
            Select-Object -First 1
        if($line){
            return ConvertFrom-CcmEnvValue ($line.Substring($line.IndexOf('=') + 1))
        }
    }
    return $Default
}

function Resolve-McpUrl([string]$Value) {
    if($Value){ return $Value }
    $configured=Resolve-CcmConfigValue 'CCM_RESOURCE'
    if($configured){ return $configured }
    throw 'MCP URL was not supplied and CCM_RESOURCE could not be resolved.'
}

function Resolve-ApprovalSecret {
    $repoRoot=Resolve-CcmRoot
    $configured=Resolve-CcmConfigValue 'CCM_APPROVAL_SECRET_FILE' '.state/ccm-approval-secret.txt'
    $path=if([IO.Path]::IsPathRooted($configured)){
        [IO.Path]::GetFullPath($configured)
    } else {
        [IO.Path]::GetFullPath((Join-Path $repoRoot $configured))
    }
    if(-not (Test-Path -LiteralPath $path)){
        throw 'CCM approval secret file is unavailable. Configure CCM_APPROVAL_SECRET_FILE or initialize CCM first.'
    }
    $secret=[IO.File]::ReadAllText($path,[Text.Encoding]::UTF8).Trim()
    if($secret.Length -lt 16){ throw 'CCM approval secret is missing or too short.' }
    return $secret
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

function Click-Element([object]$Element,[bool]$WaitForNavigation=$false) {
    if($Element.selector){
        try {
            Click ([string]$Element.selector) $WaitForNavigation
            return
        } catch {
            if($null -eq $Element.coordinates -or
               $null -eq $Element.coordinates.x -or
               $null -eq $Element.coordinates.y){
                throw
            }
        }
    }
    [void](Invoke-Bmg 'chrome_click_element' @{
        coordinates=@{
            x=[double]$Element.coordinates.x
            y=[double]$Element.coordinates.y
        }
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

function Read-PageContent {
    $value=Unwrap-Bmg (Invoke-Bmg 'chrome_read_page' @{})
    if($value -is [string]){ return [string]$value }
    if($null -ne $value.pageContent){ return [string]$value.pageContent }
    return ($value | ConvertTo-Json -Depth 12 -Compress)
}

function Find-ButtonRef([string[]]$Labels) {
    $lines=(Read-PageContent) -split "\r?\n"
    for($i=0;$i -lt $lines.Count;$i++){
        $line=[string]$lines[$i]
        if($line -notmatch '- button(?: "[^"]*")? \[ref=(ref_\d+)\]'){ continue }
        $ref=$Matches[1]
        $end=[Math]::Min($lines.Count-1,$i+3)
        $window=($lines[$i..$end] -join [Environment]::NewLine)
        foreach($label in $Labels){
            if($window.Contains('"' + $label + '"')){ return $ref }
        }
    }
    return $null
}

function Try-TrustedClickButton([string[]]$Labels) {
    $ref=Find-ButtonRef $Labels
    if(-not $ref){ return $false }
    [void](Unwrap-Bmg (Invoke-Bmg 'chrome_computer' @{
        action='left_click'
        ref=$ref
        background=$true
    }))
    return $true
}

function Complete-CcmConsent([string]$ConsentUrl) {
    $consent=[Uri]$ConsentUrl
    $mcp=[Uri]$McpUrl
    if($consent.Scheme -ne 'https' -or
       $consent.Scheme -ne $mcp.Scheme -or
       $consent.Host -ne $mcp.Host -or
       $consent.Port -ne $mcp.Port -or
       $consent.AbsolutePath -ne '/ccm/oauth/consent'){
        throw 'Refusing to send the CCM approval secret to an unexpected consent URL.'
    }

    Add-Type -AssemblyName System.Web
    Add-Type -AssemblyName System.Net.Http
    $query=[System.Web.HttpUtility]::ParseQueryString($consent.Query)
    $redirectRaw=$query['redirect_uri']
    if(-not $redirectRaw){ throw 'OAuth consent URL does not contain redirect_uri.' }
    $redirect=[Uri]$redirectRaw
    if($redirect.Scheme -ne 'https'){ throw 'OAuth redirect_uri must use HTTPS.' }

    $pairs=New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]'
    foreach($key in $query.AllKeys){
        if($null -eq $key){ continue }
        $pairs.Add((New-Object 'System.Collections.Generic.KeyValuePair[string,string]'($key,[string]$query[$key])))
    }
    $secret=Resolve-ApprovalSecret
    try {
        $pairs.Add((New-Object 'System.Collections.Generic.KeyValuePair[string,string]'('approval_secret',$secret)))
        $handler=New-Object System.Net.Http.HttpClientHandler
        $handler.AllowAutoRedirect=$false
        $client=New-Object System.Net.Http.HttpClient($handler)
        try {
            $formBody=(@($pairs) | ForEach-Object {
                [Uri]::EscapeDataString([string]$_.Key) + '=' +
                [Uri]::EscapeDataString([string]$_.Value)
            }) -join '&'
            $content=[System.Net.Http.StringContent]::new(
                $formBody,
                [Text.Encoding]::UTF8,
                'application/x-www-form-urlencoded'
            )
            $response=$client.PostAsync($consent,$content).GetAwaiter().GetResult()
            if([int]$response.StatusCode -lt 300 -or [int]$response.StatusCode -ge 400){
                throw ('CCM OAuth consent returned HTTP ' + [int]$response.StatusCode + '.')
            }
            $location=$response.Headers.Location
            if($null -eq $location){ throw 'CCM OAuth consent did not return a redirect.' }
            if(-not $location.IsAbsoluteUri){ $location=New-Object Uri($consent,$location) }
            if($location.Scheme -ne $redirect.Scheme -or
               $location.Host -ne $redirect.Host -or
               $location.Port -ne $redirect.Port -or
               $location.AbsolutePath -ne $redirect.AbsolutePath){
                throw 'CCM OAuth consent returned an unexpected callback location.'
            }
            Navigate $location.AbsoluteUri
            Start-Sleep -Seconds 2
        } finally {
            if($null -ne $client){ $client.Dispose() }
            if($null -ne $handler){ $handler.Dispose() }
        }
    } finally {
        $secret=$null
        $pairs=$null
    }
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
        # bmgctl is executed through cmd.exe and some Windows code-page
        # combinations can mojibake the localized permission suffix while
        # preserving the connector name. Accept a non-ASCII suffix, but do
        # not let "CCM" match the distinct ASCII-named "CCM Old" entry.
        if($text.StartsWith($Name,[StringComparison]::Ordinal)){
            $suffix=$text.Substring($Name.Length)
            if($suffix -and $suffix[0] -gt [char]127){
                return $element
            }
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
    Click-Element $Connector
    Start-Sleep -Milliseconds 700
    $state=Connector-UiState
    if($state -eq 'connected'){ return 'ui_connected' }
    if($state -eq 'unknown'){ return 'unknown' }
    $connect=Find-ExactButton @(
        '连接另一个账户',
        'Connect another account',
        '连接',
        'Connect'
    )
    if(-not $connect){ return 'unknown' }
    if(-not (Try-TrustedClickButton @(
        '连接另一个账户',
        'Connect another account',
        '连接',
        'Connect'
    ))){
        Click-Element $connect
    }
    Start-Sleep -Milliseconds 500
    [void](Try-TrustedClickButton @(
        ('使用 ' + $CurrentName + ' 登录'),
        ('Use ' + $CurrentName + ' to sign in'),
        ('Sign in with ' + $CurrentName)
    ))
    for($i=0;$i -lt 10;$i++){
        Start-Sleep -Milliseconds 500
        $tab=Current-Tab
        if($tab -and ([string]$tab.url) -match '/ccm/oauth/consent'){
            Complete-CcmConsent ([string]$tab.url)
            return 'oauth_completed'
        }
    }
    return 'connection_started'
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

$resumeTab=Current-Tab
if($resumeTab -and ([string]$resumeTab.url) -match '/ccm/oauth/consent'){
    Complete-CcmConsent ([string]$resumeTab.url)
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
        Complete-CcmConsent ([string]$tab.url)
        Plugin-Settings
        $current=Find-Installed $CurrentName
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
if($connection -in @('connection_started','unknown')){
    Emit 'connection_required' @{
        current_present=$true
        old_present=($null -ne $old)
        ui_connection_state=$connection
        host_verification_required=$true
        message='The fresh connector is not yet proven connected. Do not treat CCM Old tool availability as proof for the fresh CCM.'
    }
    exit 0
}

if($connection -eq 'oauth_completed'){
    Plugin-Settings
    $current=Find-Installed $CurrentName
    if(-not $current){
        Emit 'connection_pending' @{
            current_present=$false
            old_present=($null -ne $old)
            host_verification_required=$true
            message='OAuth completed, but the fresh CCM registration is not visible yet. Run the tool again to resume.'
        }
        exit 0
    }
    Click-Element $current
    Start-Sleep -Milliseconds 700
    $uiState=Connector-UiState
    if($uiState -ne 'connected'){
        Emit 'connection_pending' @{
            current_present=$true
            old_present=($null -ne $old)
            ui_connection_state=$uiState
            host_verification_required=$true
            message='OAuth completed, but ChatGPT UI has not yet confirmed the fresh CCM account connection.'
        }
        exit 0
    }
    $connection='ui_connected'
}

if(-not $KeepWorkspaceVisible){ [void](Invoke-Bmg 'bmg_hide_workspace' @{}) }
Emit 'host_verification_required' @{
    current_present=$true
    old_present=($null -ne $old)
    ui_connection_state=$connection
    host_verification_required=$true
    message='ChatGPT UI reports a connected account for the fresh CCM. Final success still requires the host ChatGPT session to expose the fresh CCM namespace/app instance and successfully execute a read-only tool from it. CCM Old availability does not count.'
}
