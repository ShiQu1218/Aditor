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

Invoke-Step "app typecheck" $app { npm run typecheck }

if ($Tier -eq "fast") {
    Invoke-Step "app vitest (fast)" $app { npm run test:fast }
} else {
    Invoke-Step "app vitest (all, incl. real engine/ffmpeg)" $app { npm test }
}

$pytestMarker = if ($Tier -eq "fast") { "not slow" } else { "slow or not slow" }
Invoke-Step "engine pytest ($Tier)" (Join-Path $root "engine") { & $python -m pytest -q -m $pytestMarker }

# The recorder tests link against the bundled FFmpeg DLLs and the e2e tests read ADITORREC_FFMPEG_DIR.
$ffmpegRoot = Join-Path $root "build/ffmpeg"
$env:ADITORREC_FFMPEG_DIR = $ffmpegRoot
$env:PATH = "$(Join-Path $ffmpegRoot 'bin');$env:PATH"
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
