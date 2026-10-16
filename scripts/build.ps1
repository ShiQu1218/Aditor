# scripts/build.ps1
# Build script for Apex Highlighter: Engine (PyInstaller) + LGPL FFmpeg + Electron App (electron-builder)
param(
    [switch]$SkipEngine,
    [switch]$SkipFfmpeg
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath("$PSScriptRoot\..")
Set-Location $root

Write-Host "========================================"
Write-Host " Building Apex Highlighter Application"
Write-Host "========================================"

# 1. Build Engine
if (-not $SkipEngine) {
    Write-Host "`n[1/4] Building Engine with PyInstaller..."
    $pyinstaller = Join-Path $root "engine\.venv\Scripts\pyinstaller.exe"
    if (-not (Test-Path $pyinstaller)) {
        Write-Host "PyInstaller not found in venv, installing..."
        & (Join-Path $root "engine\.venv\Scripts\python.exe") -m pip install "pyinstaller==6.22.3"
    }

    $distPath = Join-Path $root "build\engine"
    $workPath = Join-Path $root "build\pyinstaller-temp"
    $specPath = Join-Path $root "engine\apexhl.spec"

    & $pyinstaller --distpath $distPath --workpath $workPath -y $specPath
    $engineExe = Join-Path $distPath "apexhl\apexhl.exe"
    if (-not (Test-Path $engineExe)) {
        throw "Engine build failed: $engineExe not found!"
    }
    Write-Host "✓ Engine built successfully: $engineExe"
} else {
    Write-Host "`n[1/4] Skipping engine build."
}

# 2. Fetch & verify LGPL FFmpeg
if (-not $SkipFfmpeg) {
    Write-Host "`n[2/4] Fetching & verifying LGPL FFmpeg..."
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
    Write-Host "`n[2/4] Skipping FFmpeg fetch."
}

# 3. Build Web & Electron bundles
Write-Host "`n[3/4] Building Electron Renderer & Main process..."
Set-Location (Join-Path $root "app")
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed"
}
Write-Host "✓ electron-vite build succeeded."

# 4. Package with electron-builder
Write-Host "`n[4/4] Packaging installer and portable with electron-builder..."
npx electron-builder --win
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
