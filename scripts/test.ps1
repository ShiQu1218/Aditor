# scripts/test.ps1
# Run the project test suites in one place.
#   fast: typecheck + vitest (no real-binary tests) + engine/recorder cargo test. Run before every commit.
#   full: fast + real engine/ffmpeg vitest tests + gated ignored cargo tests + Playwright e2e. Run before a PR or release.
param(
    [ValidateSet("fast", "full")]
    [string]$Tier = "fast",
    [switch]$KeepGoing
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath("$PSScriptRoot\..")
$failures = New-Object System.Collections.Generic.List[string]

function Invoke-Step {
    param([string]$Name, [string]$WorkDir, [scriptblock]$Command)
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    Push-Location $WorkDir
    try {
        & $Command
        if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
    } catch {
        $failures.Add($Name)
        Write-Host $_.Exception.Message -ForegroundColor Red
        if (-not $KeepGoing) { throw }
    } finally {
        Pop-Location
    }
}

$app = Join-Path $root "app"

# Every suite must exercise the same bundled FFmpeg. Use PATH rather than
# ADITOR_FFMPEG: subprocess lookup tests control their own overrides.
$ffmpegRoot = Join-Path $root "build/ffmpeg"
foreach ($binary in @('ffmpeg.exe', 'ffprobe.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ffmpegRoot "bin/$binary"))) {
        throw "Bundled $binary not found; run scripts/fetch-ffmpeg.ps1 before testing"
    }
}
$savedEnvironment = @{}
foreach ($name in @('PATH', 'ADITOR_FFMPEG', 'ADITOR_FFPROBE', 'ADITORREC_FFMPEG_DIR', 'CARGO_BUILD_JOBS')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PATH = "$(Join-Path $ffmpegRoot 'bin');$env:PATH"
    $env:ADITOR_FFMPEG = $null
    $env:ADITOR_FFPROBE = $null
    $env:ADITORREC_FFMPEG_DIR = $ffmpegRoot
    $env:CARGO_BUILD_JOBS = '4'

    Invoke-Step "FFmpeg components" $root {
        & "$PSScriptRoot/verify-ffmpeg-components.ps1" -FfmpegPath (Join-Path $ffmpegRoot 'bin/ffmpeg.exe')
    }

    if ($Tier -eq "full") {
        Invoke-Step "engine release build for real app tests" (Join-Path $root "engine") { cargo build --release }
    }

    Invoke-Step "app typecheck" $app { npm run typecheck }
    Invoke-Step "app lint" $app { npm run lint }

    if ($Tier -eq "fast") {
        Invoke-Step "app vitest (fast)" $app { npm run test:fast }
    } else {
        Invoke-Step "app vitest (all, incl. real engine/ffmpeg)" $app { npm test }
    }

    Invoke-Step "engine cargo test" (Join-Path $root "engine") { cargo test -- --test-threads=4 }
    if ($Tier -eq "full") {
        if ($env:ADITOR_GOLDEN_VIDEO) {
            Invoke-Step "engine golden tests" (Join-Path $root "engine") { cargo test --test analyze --test live golden -- --include-ignored --test-threads=4 }
        }
        if ($env:ADITOR_MATCH_DIR) {
            Invoke-Step "engine match acceptance" (Join-Path $root "engine") { cargo test --test matches --test live recording -- --include-ignored --test-threads=4 }
        }
    }

    # The recorder tests link against the bundled FFmpeg DLLs.
    # GitHub-hosted runners have no hardware D3D11 adapter or audio devices, so skip the tests that need them
    # (including the whole e2e_recording suite, which records real windows).
    $cargoSkips = if ($env:GITHUB_ACTIONS -eq "true") {
        @("gpu_idle_black_frames", "opens_shared_texture", "shared_texture_open_and_convert", "capture_loop_delivers_frames",
          "gpu_luma_uses_full_thumb", "gpu_nv12_conversion", "gpu_recording_and_scaling", "gpu_static_capture",
          "actual_default_loopback_and_microphone", "gpu_small_frames_preserve_roi", "wgc_captures_pixels_resizes") | ForEach-Object { "--skip", $_ }
    } else { @() }
    Invoke-Step "recorder cargo test" (Join-Path $root "recorder") { if ($cargoSkips) { cargo test --no-fail-fast --bins --test audio_capture --test capture_dda --test capture_wgc --test ipc_process -- @cargoSkips } else { cargo test } }

    if ($Tier -eq "full") {
        if (-not $env:ADITOR_GOLDEN_VIDEO) {
            Write-Host "`nNote: ADITOR_GOLDEN_VIDEO is not set, so engine golden tests were skipped." -ForegroundColor Yellow
        }
        Invoke-Step "app e2e (Playwright)" $app { npm run test:e2e }
    }

    if ($failures.Count -gt 0) {
        Write-Host "`nFAILED: $($failures -join ', ')" -ForegroundColor Red
        exit 1
    }
    Write-Host "`nAll '$Tier' steps passed." -ForegroundColor Green
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
