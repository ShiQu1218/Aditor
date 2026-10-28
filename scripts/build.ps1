# scripts/build.ps1
# Build the engine, LGPL FFmpeg, OBS hook, Rust recorder, and Electron installer.
param(
    [switch]$SkipEngine,
    [switch]$EngineOnly,
    [switch]$SkipFfmpeg,
    [switch]$SkipObsHook
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath("$PSScriptRoot\..")
Set-Location $root

Write-Host "========================================"
Write-Host " Building Aditor Application"
Write-Host "========================================"

# 1. Build Engine
if (-not $SkipEngine) {
    Write-Host "`n[1/6] Building Rust engine..."
    $releaseExe = Join-Path $root "engine/target/release/aditor.exe"
    # Cargo relinks whenever sources change; its uplifted exe keeps the link time, so compare hashes, not mtimes.
    cargo build --release --manifest-path (Join-Path $root "engine/Cargo.toml")
    if ($LASTEXITCODE -ne 0) { throw "Rust engine build failed" }
    if (-not (Test-Path -LiteralPath $releaseExe)) { throw "Engine build failed: $releaseExe not found!" }
    $distPath = Join-Path $root "build/engine/aditor"
    New-Item -ItemType Directory -Force -Path $distPath | Out-Null
    $engineExe = Join-Path $distPath "aditor.exe"
    Copy-Item -LiteralPath $releaseExe -Destination $engineExe -Force
    if ((Get-FileHash -LiteralPath $engineExe).Hash -ne (Get-FileHash -LiteralPath $releaseExe).Hash) {
        throw "Engine build failed: staged $engineExe does not match the cargo release build!"
    }
    Write-Host "✓ Engine built successfully: $engineExe"
} else {
    Write-Host "`n[1/6] Skipping engine build."
    $releaseExe = Join-Path $root "engine/target/release/aditor.exe"
    $engineExe = Join-Path $root "build/engine/aditor/aditor.exe"
    if (-not (Test-Path -LiteralPath $releaseExe) -or -not (Test-Path -LiteralPath $engineExe) -or
        (Get-FileHash -LiteralPath $engineExe).Hash -ne (Get-FileHash -LiteralPath $releaseExe).Hash) {
        throw "Staged engine does not match the cargo release build; run scripts/build.ps1 -EngineOnly first"
    }
}

if ($EngineOnly) {
    & "$PSScriptRoot/verify-live-engine.ps1"
    return
}

# 2. Fetch & verify LGPL FFmpeg
if (-not $SkipFfmpeg) {
    Write-Host "`n[2/6] Fetching & verifying LGPL FFmpeg..."
    $fetchScript = Join-Path $root "scripts\fetch-ffmpeg.ps1"
    & powershell -ExecutionPolicy Bypass -File $fetchScript
    if ($LASTEXITCODE -ne 0) {
        throw "fetch-ffmpeg.ps1 failed (pinned version / SHA256 verification) - refusing to package an unverified FFmpeg"
    }
    $ffmpegExe = Join-Path $root "build\ffmpeg\bin\ffmpeg.exe"
    if (-not (Test-Path $ffmpegExe)) {
        throw "FFmpeg not found: $ffmpegExe"
    }
    Write-Host "✓ FFmpeg ready: $ffmpegExe"
} else {
    Write-Host "`n[2/6] Skipping FFmpeg fetch."
}

# 3. Fetch & verify OBS graphics-hook
if (-not $SkipObsHook) {
    Write-Host "`n[3/6] Fetching & verifying OBS graphics-hook..."
    $fetchObsHookScript = Join-Path $root "scripts\fetch-obs-hook.ps1"
    & powershell -ExecutionPolicy Bypass -File $fetchObsHookScript
    if ($LASTEXITCODE -ne 0) {
        throw "fetch-obs-hook.ps1 failed (pinned version / SHA256 / Authenticode verification) - refusing to package unverified OBS hook binaries"
    }
    $obsHookDir = Join-Path $root "build\obs-hook"
    foreach ($hookFile in @("graphics-hook64.dll", "inject-helper64.exe", "get-graphics-offsets64.exe")) {
        $hookFilePath = Join-Path $obsHookDir $hookFile
        if (-not (Test-Path $hookFilePath)) {
            throw "OBS hook file not found: $hookFilePath"
        }
    }
    Write-Host "✓ OBS hook ready: $obsHookDir"
} else {
    Write-Host "`n[3/6] Skipping OBS hook fetch."
}

# 4. Build the recorder and place it beside the FFmpeg DLLs.
Write-Host "`n[4/6] Building Rust recorder..."
$previousFfmpegDir = $env:ADITORREC_FFMPEG_DIR
try {
    $env:ADITORREC_FFMPEG_DIR = Join-Path $root "build\ffmpeg"
    Push-Location (Join-Path $root "recorder")
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed" }
    } finally {
        Pop-Location
    }
    Copy-Item -LiteralPath (Join-Path $root "recorder\target\release\aditorrec.exe") -Destination (Join-Path $root "build\ffmpeg\bin\aditorrec.exe") -Force
} finally {
    $env:ADITORREC_FFMPEG_DIR = $previousFfmpegDir
}

# Refuse to package a stale engine, including when -SkipEngine was requested.
& "$PSScriptRoot\verify-live-engine.ps1"

# 5. Build Web & Electron bundles
Write-Host "`n[5/6] Building Electron Renderer & Main process..."
Set-Location (Join-Path $root "app")
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed"
}
Write-Host "✓ electron-vite build succeeded."

# 6. Package with electron-builder
Write-Host "`n[6/6] Packaging installer and portable with electron-builder..."
npx electron-builder --win --publish never
if ($LASTEXITCODE -ne 0) {
    throw "electron-builder packaging failed"
}

Set-Location $root
$distDir = Join-Path $root "dist"
Write-Host "`n========================================"
Write-Host " Build Complete!"
Write-Host " Output artifacts in ${distDir}:"
Get-ChildItem -Path $distDir | Where-Object { $_.Extension -in @(".exe", ".zip") } | ForEach-Object {
    Write-Host "  - $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)"
}
Write-Host "========================================"
