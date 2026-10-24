# scripts/test.ps1
# Run the project test suites in one place.
#   fast: typecheck + vitest (no real-binary tests) + pytest (excluding slow) + cargo test. Run before every commit.
#   full: fast + real engine/ffmpeg vitest tests + slow pytest + Playwright e2e. Run before a PR or release.
param(
    [ValidateSet("fast", "full")]
    [string]$Tier = "fast",
    [switch]$KeepGoing
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath("$PSScriptRoot\..")
$python = Join-Path $root "engine\.venv\Scripts\python.exe"
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

if (-not (Test-Path $python)) { throw "Engine venv not found: $python" }
$app = Join-Path $root "app"

# Every suite must exercise the same bundled FFmpeg. Use PATH rather than
# ADITOR_FFMPEG: ffbin's missing-binary tests intentionally replace PATH and
# BUNDLED_DIR, and an inherited override would bypass those checks.
$ffmpegRoot = Join-Path $root "build/ffmpeg"
foreach ($binary in @('ffmpeg.exe', 'ffprobe.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ffmpegRoot "bin/$binary"))) {
        throw "Bundled $binary not found; run scripts/fetch-ffmpeg.ps1 before testing"
    }
}
$savedEnvironment = @{}
foreach ($name in @('PATH', 'ADITOR_FFMPEG', 'ADITOR_FFPROBE', 'ADITORREC_FFMPEG_DIR')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PATH = "$(Join-Path $ffmpegRoot 'bin');$env:PATH"
    $env:ADITOR_FFMPEG = $null
    $env:ADITOR_FFPROBE = $null
    $env:ADITORREC_FFMPEG_DIR = $ffmpegRoot

    Invoke-Step "FFmpeg components" $root {
        & "$PSScriptRoot/verify-ffmpeg-components.ps1" -FfmpegPath (Join-Path $ffmpegRoot 'bin/ffmpeg.exe')
    }

    Invoke-Step "app typecheck" $app { npm run typecheck }
    Invoke-Step "app lint" $app { npm run lint }

    if ($Tier -eq "fast") {
        Invoke-Step "app vitest (fast)" $app { npm run test:fast }
    } else {
        Invoke-Step "app vitest (all, incl. real engine/ffmpeg)" $app { npm test }
    }

    $pytestMarker = if ($Tier -eq "fast") { "not slow" } else { "slow or not slow" }
    Invoke-Step "engine pytest ($Tier)" (Join-Path $root "engine") { & $python -m pytest -q -m $pytestMarker }

    # The recorder tests link against the bundled FFmpeg DLLs.
    Invoke-Step "recorder cargo test" (Join-Path $root "recorder") { cargo test }

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
