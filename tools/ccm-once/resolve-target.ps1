param(
  [Parameter(Mandatory=$true)][string]$DirectoryFilePath,
  [Parameter(Mandatory=$true)][string]$FilenameFilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-CcmOneTimeDescriptor {
  param(
    [Parameter(Mandatory=$true)][string]$DescriptorPath,
    [Parameter(Mandatory=$true)][string]$Label
  )

  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DescriptorPath)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw ($Label + ' descriptor file is unavailable.')
  }

  $value = [IO.File]::ReadAllText($resolved).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw ($Label + ' descriptor is empty.')
  }
  if ($value -match '[\r\n]') {
    throw ($Label + ' descriptor must contain exactly one value.')
  }
  return $value
}

$directoryValue = Read-CcmOneTimeDescriptor -DescriptorPath $DirectoryFilePath -Label 'Directory'
$filenameValue = Read-CcmOneTimeDescriptor -DescriptorPath $FilenameFilePath -Label 'Filename'

try {
  $directory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($directoryValue)
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw 'missing'
  }
  $directory = (Get-Item -LiteralPath $directory -Force).FullName
} catch {
  throw 'Target directory is unavailable.'
}

if ([IO.Path]::IsPathRooted($filenameValue) -or
    $filenameValue.Contains('\') -or
    $filenameValue.Contains('/') -or
    $filenameValue -eq '.' -or
    $filenameValue -eq '..' -or
    $filenameValue.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
  throw 'Filename descriptor must contain only one valid leaf filename.'
}

try {
  $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
    (Join-Path -Path $directory -ChildPath $filenameValue)
  )
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw 'missing'
  }
  Write-Output (Get-Item -LiteralPath $target -Force).FullName
} catch {
  throw 'Target text file is unavailable.'
}
