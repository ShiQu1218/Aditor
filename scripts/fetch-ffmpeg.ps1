# scripts/fetch-ffmpeg.ps1
param(
    [string]$TargetDir = "$PSScriptRoot\..\build\ffmpeg"
)

$ErrorActionPreference = "Stop"

# Pin a named autobuild (do not use releases/download/latest, which changes to a different master snapshot every day).
# Stay on the 8.1 release branch: BtbN builds it with NVENC SDK 13.0 (driver 570+, still available for GTX 10 series);
# master and 9.x use SDK 13.1, which requires driver 610+ and drops Pascal/Maxwell GPUs.
# Build recipe and upgrade instructions: ffmpeg-build/README.md.
# To upgrade FFmpeg, update the three values below and the version notes in THIRD_PARTY_NOTICES.md (and recorder/src/encode/nvenc.rs REQUIRED_API/MIN_DRIVER when the NVENC SDK changes).
$tag = "aditor-8.1-20261023.1"
$asset = "ffmpeg-46d899d-win64-lgpl-shared-aditor-8.1.zip"
$expectedSha256 = "087FDFD152EA5243CFFBF196BC488BCC9AF0F0898B81FD4A115F32167D489BEB"
$url = "https://github.com/ShiQu1218/Aditor-FFmpeg/releases/download/$tag/$asset"

$buildDir = [System.IO.Path]::GetFullPath("$PSScriptRoot\..\build")
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
}

$zipPath = Join-Path $buildDir "ffmpeg-lgpl-shared-$expectedSha256.zip"

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
# The stamp records which archive was extracted, so a pin change replaces an older build/ffmpeg instead of
# packaging stale DLLs next to a recorder built for different FFmpeg bindings.
# It sits beside the directory because build/ffmpeg is packaged as-is.
$stampPath = "$targetFullPath.sha256"
$extractedSha256 = if (Test-Path $stampPath) { (Get-Content -Raw -LiteralPath $stampPath).Trim() } else { "" }
if (-not (Test-Path (Join-Path $targetFullPath "bin\ffmpeg.exe")) -or $extractedSha256 -ne $expectedSha256) {
    Write-Host "Extracting to $targetFullPath..."
    $tempExtract = Join-Path $buildDir "ffmpeg_extract_temp"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force

    $subDir = Get-ChildItem -Path $tempExtract | Where-Object { $_.PSIsContainer } | Select-Object -First 1
    if (Test-Path $targetFullPath) { Remove-Item -Recurse -Force $targetFullPath }
    Move-Item -Path $subDir.FullName -Destination $targetFullPath
    Remove-Item -Recurse -Force $tempExtract
    Set-Content -LiteralPath $stampPath -Value $expectedSha256 -Encoding ascii
}

$ffmpegExe = Join-Path $targetFullPath "bin\ffmpeg.exe"
if (-not (Test-Path $ffmpegExe)) {
    throw "ffmpeg.exe not found at $ffmpegExe"
}

Write-Host "Verifying FFmpeg license and features via buildconf..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$buildconf = & $ffmpegExe -buildconf 2>&1 | Out-String
$buildconfExitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($buildconfExitCode -ne 0) {
    throw "FFmpeg -buildconf failed (exit $buildconfExitCode)."
}

if ($buildconf -match "--enable-gpl") {
    throw "FATAL: FFmpeg binary contains --enable-gpl! Must be LGPL only."
}
if ($buildconf -match "--enable-nonfree") {
    throw "FATAL: FFmpeg binary contains --enable-nonfree! Must be LGPL only."
}
if (-not ($buildconf -match "--enable-libdav1d")) {
    throw "FATAL: FFmpeg binary missing --enable-libdav1d for AV1 decoding."
}
if (-not ($buildconf -match "--enable-libopenh264")) {
    throw "FATAL: FFmpeg binary missing --enable-libopenh264 for software H.264 fallback."
}

# Retain compatibility with the original BtbN pin for deliberate rollback. Custom
# Aditor releases also require the compiled component metadata and 40 MB package gate.
$minimal = $asset -match '-lgpl-shared-aditor-'
& "$PSScriptRoot\verify-ffmpeg-components.ps1" -FfmpegPath $ffmpegExe -Strict:$minimal -CheckPackage:$minimal

Write-Host "✓ FFmpeg LGPL and component verification passed: libdav1d and libopenh264 available."
