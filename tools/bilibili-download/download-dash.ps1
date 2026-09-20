[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $VideoUrl,
    [Parameter(Mandatory = $true)]
    [string] $AudioUrl,
    [Parameter(Mandatory = $true)]
    [string] $OutputPath,
    [string] $Referer = 'https://www.bilibili.com/',
    [string] $UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    [ValidateRange(1, 86400)]
    [int] $TimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'
$curl = (Get-Command curl.exe -ErrorAction Stop | Select-Object -First 1).Source
$ffmpeg = (Get-Command ffmpeg.exe -ErrorAction Stop | Select-Object -First 1).Source
$ffprobe = (Get-Command ffprobe.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDir = Split-Path -Parent $resolvedOutput
if (-not $outputDir) {
    $outputDir = (Get-Location).Path
    $resolvedOutput = Join-Path $outputDir (Split-Path -Leaf $OutputPath)
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$stamp = [Guid]::NewGuid().ToString('N')
$videoTemp = Join-Path $outputDir ('.ccm-bilibili-' + $stamp + '-video.m4s')
$audioTemp = Join-Path $outputDir ('.ccm-bilibili-' + $stamp + '-audio.m4s')
$mergedTemp = Join-Path $outputDir ('.ccm-bilibili-' + $stamp + '-merged.mp4')
function Download-Stream([string] $Url, [string] $Destination) {
    $arguments = @(
        '--fail',
        '--location',
        '--retry', '3',
        '--retry-delay', '1',
        '--connect-timeout', '15',
        '--max-time', [string]$TimeoutSeconds,
        '--user-agent', $UserAgent,
        '--referer', $Referer,
        '--output', $Destination,
        $Url
    )
    & $curl @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed with exit code $LASTEXITCODE"
    }
}

try {
    Download-Stream $VideoUrl $videoTemp
    Download-Stream $AudioUrl $audioTemp

    $ffmpegArgs = @(
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', $videoTemp,
        '-i', $audioTemp,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        $mergedTemp
    )
    & $ffmpeg @ffmpegArgs
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed with exit code $LASTEXITCODE"
    }

    Move-Item -LiteralPath $mergedTemp -Destination $resolvedOutput -Force

    $result = [ordered]@{
        ok = $true
        output_path = $resolvedOutput
        byte_length = (Get-Item -LiteralPath $resolvedOutput).Length
        remux = 'ffmpeg -c copy'
    }

    if ($ffprobe) {
        $probeArgs = @(
            '-v', 'error',
            '-show_entries', 'stream=index,codec_type,codec_name,width,height',
            '-show_entries', 'format=duration,size',
            '-of', 'json',
            $resolvedOutput
        )
        $probeJson = & $ffprobe @probeArgs
        if ($LASTEXITCODE -eq 0 -and $probeJson) {
            try {
                $result.probe = $probeJson | ConvertFrom-Json
            } catch {}
        }
    }
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Remove-Item -LiteralPath $videoTemp,$audioTemp,$mergedTemp -Force -ErrorAction SilentlyContinue
}
