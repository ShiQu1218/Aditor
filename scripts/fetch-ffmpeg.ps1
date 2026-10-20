# scripts/fetch-ffmpeg.ps1
param(
    [string]$TargetDir = "$PSScriptRoot\..\build\ffmpeg"
)

$ErrorActionPreference = "Stop"

# Pin a named autobuild (do not use releases/download/latest, which changes to a different master snapshot every day).
# To upgrade FFmpeg, update the three values below and the version notes in THIRD_PARTY_NOTICES.md and README.
$tag = "autobuild-2026-10-14-13-03"
$asset = "ffmpeg-N-127527-g045dea2a34-win64-lgpl-shared.zip"
$expectedSha256 = "B5D1AE0224E45AC0830EBB347EE30EE57DB2025D869DE4D5D09CFBD37093BA06"
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$tag/$asset"

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
    # Fail on a mismatch: do not extract or package an unverified binary. Delete $zipPath and rerun to download again.
    throw "FATAL: SHA256 mismatch for $asset! Expected $expectedSha256, got $actualSha256. Delete $zipPath and retry, or update the pinned values deliberately."
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
