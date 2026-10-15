# scripts/fetch-ffmpeg.ps1
param(
    [string]$TargetDir = "$PSScriptRoot\..\build\ffmpeg"
)

$ErrorActionPreference = "Stop"

$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip"
$expectedSha256 = "E21DE3AEC26570FD958746461B2BE560901FE4E4365539C1D86955184024FB75"

$buildDir = [System.IO.Path]::GetFullPath("$PSScriptRoot\..\build")
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
}

$zipPath = Join-Path $buildDir "ffmpeg-lgpl-shared.zip"

if (-not (Test-Path $zipPath)) {
    Write-Host "Downloading LGPL FFmpeg build from $url..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath
} else {
    Write-Host "Found existing download at $zipPath"
}

$actualSha256 = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
Write-Host "Verifying SHA256: $actualSha256"
if ($actualSha256 -ne $expectedSha256) {
    Write-Warning "SHA256 mismatch! Expected $expectedSha256, got $actualSha256. (If upstream updated 'latest', verify buildconf)."
}

$targetFullPath = [System.IO.Path]::GetFullPath($TargetDir)
if (-not (Test-Path (Join-Path $targetFullPath "bin\ffmpeg.exe"))) {
    Write-Host "Extracting to $targetFullPath..."
    $tempExtract = Join-Path $buildDir "ffmpeg_extract_temp"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force

    $subDir = Get-ChildItem -Path $tempExtract | Where-Object { $_.PSIsContainer } | Select-Object -First 1
    if (Test-Path $targetFullPath) { Remove-Item -Recurse -Force $targetFullPath }
    Move-Item -Path $subDir.FullName -Destination $targetFullPath
    Remove-Item -Recurse -Force $tempExtract
}

$ffmpegExe = Join-Path $targetFullPath "bin\ffmpeg.exe"
if (-not (Test-Path $ffmpegExe)) {
    throw "ffmpeg.exe not found at $ffmpegExe"
}

Write-Host "Verifying FFmpeg license and features via buildconf..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$buildconf = & $ffmpegExe -buildconf 2>&1 | Out-String
$ErrorActionPreference = $prevEAP

if ($buildconf -match "--enable-gpl") {
    throw "FATAL: FFmpeg binary contains --enable-gpl! Must be LGPL only."
}
if ($buildconf -match "--enable-nonfree") {
    throw "FATAL: FFmpeg binary contains --enable-nonfree! Must be LGPL only."
}
if (-not ($buildconf -match "--enable-libdav1d")) {
    throw "FATAL: FFmpeg binary missing --enable-libdav1d for AV1 decoding."
}

Write-Host "✓ FFmpeg LGPL verification passed: LGPL compliant with libdav1d."
