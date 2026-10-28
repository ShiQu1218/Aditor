#Requires -Version 7.0
[CmdletBinding()]
param(
    [string[]]$Scenarios = @('baseline', 'record', 'record_analyze'),
    [ValidateRange(1, 1000)][int]$Repeat = 3,
    [Parameter(Mandatory)][string]$Source,
    [ValidateRange(0, 86400)][double]$ClipStart = 0,
    [ValidateRange(0.1, 60)][double]$ClipSeconds = 12,
    [ValidatePattern('^\d+x\d+$')][string]$Size = '1920x1080',
    [ValidateRange(1, 240)][int]$ClipFps = 60,
    [string]$Ffmpeg = (Join-Path $PSScriptRoot '../../build/ffmpeg/bin/ffmpeg.exe'),
    [string]$AnalysisSource = '',
    [ValidateRange(0, 86400)][double]$AnalyzeAtS = 30,
    [ValidateRange(1, 86400)][double]$DurationS = 60,
    [ValidateRange(0, 3600)][double]$WarmupS = 5,
    [ValidateRange(0, 3600)][double]$CooldownS = 10,
    [ValidateRange(0, 10000)][int]$LoadPasses = 0,
    [ValidateRange(0, 10000)][double]$FpsCap = 0,
    [string]$Windowed = '',
    [ValidateSet('auto', 'wgc', 'dda', 'hook')][string]$CaptureMethod = 'auto',
    [ValidateSet('speed', 'balanced', 'quality')][string]$Preset = 'speed',
    [ValidateRange(10, 180)][int]$StartTimeoutS = 120,
    [ValidateRange(10, 600)][int]$FinalizeTimeoutS = 120,
    [string]$CacheDir = (Join-Path ([IO.Path]::GetTempPath()) 'aditor-fakegame-cache'),
    [string]$ResultsDir = (Join-Path ([IO.Path]::GetTempPath()) 'aditor-fakegame-results'),
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$appDir = Join-Path $repo 'app'
$crate = Join-Path $repo 'tools/fakegame'
$Scenarios = @($Scenarios | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim() })
$allowedScenarios = @('baseline', 'record', 'record_analyze', 'app_idle', 'rec_capture', 'rec_encode', 'rec_audio', 'rec_live')
$appScenarios = @('record', 'record_analyze', 'app_idle')
if (!$Scenarios.Count -or @($Scenarios | Where-Object { $_ -notin $allowedScenarios }).Count) {
    throw "Scenarios must be selected from: $($allowedScenarios -join ', ')."
}
if (@($Scenarios | Select-Object -Unique).Count -ne $Scenarios.Count) { throw 'Duplicate scenarios are not allowed.' }
if ($Scenarios -contains 'record_analyze' -and $AnalyzeAtS -ge $DurationS) { throw 'AnalyzeAtS must be less than DurationS.' }
foreach ($value in @($ClipStart, $ClipSeconds, $AnalyzeAtS, $DurationS, $WarmupS, $CooldownS, $FpsCap)) {
    if (![double]::IsFinite($value)) { throw 'Numeric parameters must be finite.' }
}
function Check-Size([string]$Value) {
    if ($Value -notmatch '^(\d+)x(\d+)$') { throw "Invalid dimensions: $Value" }
    foreach ($dimension in @([int]$Matches[1], [int]$Matches[2])) {
        if ($dimension -le 0 -or $dimension -gt 16384 -or $dimension % 2) { throw 'Dimensions must be positive, even, and <= 16384.' }
    }
}
Check-Size $Size
if ($Windowed) { Check-Size $Windowed }
function Write-Json([string]$Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 15).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}
function Check-Exit([string]$Label) {
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
}
function Assert-NoAditor {
    $busy = @(Get-Process | Where-Object {
        $_.ProcessName -match '^(Aditor|aditorrec|r5apex|r5apex_dx12|fakegame|VALORANT-Win64-Shipping)$' -or
        ($_.ProcessName -eq 'electron' -and $_.Path -like "$appDir\*")
    })
    if ($busy.Count) { throw "Close existing Aditor/Apex/recorder processes first; the harness never stops unrelated processes. PIDs: $($busy.Id -join ', ')" }
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$Ffmpeg = (Resolve-Path -LiteralPath $Ffmpeg).Path
if ($Scenarios -contains 'record_analyze') {
    if (!$AnalysisSource) { throw 'record_analyze requires -AnalysisSource (a video to analyze in the background).' }
    $AnalysisSource = (Resolve-Path -LiteralPath $AnalysisSource).Path
}
$CacheDir = [IO.Path]::GetFullPath($CacheDir)
if ($CacheDir.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $CacheDir -eq $repo) {
    throw 'CacheDir must be outside the repository.'
}
Assert-NoAditor
foreach ($executable in @('cargo', 'node', 'npm.cmd', $Python)) { Get-Command $executable -ErrorAction Stop | Out-Null }
$requiredFiles = @()
if (@($Scenarios | Where-Object { $_ -ne 'baseline' }).Count) { $requiredFiles += 'recorder/target/release/aditorrec.exe' }
if (@($Scenarios | Where-Object { $_ -in @('record', 'record_analyze', 'app_idle', 'rec_live') }).Count) { $requiredFiles += 'engine/target/release/aditor.exe' }
if (@($Scenarios | Where-Object { $_ -in $appScenarios }).Count) { $requiredFiles += 'app/node_modules/electron/dist/electron.exe' }
foreach ($required in $requiredFiles) {
    if (!(Test-Path -LiteralPath (Join-Path $repo $required))) { throw "Missing prerequisite: $required. See tools/perf/README.md." }
}
$oldPath = $env:PATH
$oldFfmpegDir = $env:ADITORREC_FFMPEG_DIR
try {
    $env:PATH = (Split-Path $Ffmpeg) + [IO.Path]::PathSeparator + $env:PATH
    $env:ADITORREC_FFMPEG_DIR = Split-Path $Ffmpeg
    Push-Location $crate
    try { & cargo build --release; Check-Exit 'Fake-game release build' } finally { Pop-Location }
    if (@($Scenarios | Where-Object { $_ -in $appScenarios }).Count) {
        Push-Location $appDir
        try { & npm.cmd run build; Check-Exit 'Aditor build' } finally { Pop-Location }
    }
    [IO.Directory]::CreateDirectory($CacheDir) | Out-Null
    $sourceInfo = Get-Item -LiteralPath $Source
    $ffmpegInfo = Get-Item -LiteralPath $Ffmpeg
    $cacheInfo = [ordered]@{ schema = 1; source = $Source; sourceBytes = $sourceInfo.Length
        sourceMtime = $sourceInfo.LastWriteTimeUtc.Ticks; clipStart = $ClipStart; clipSeconds = $ClipSeconds
        size = $Size; fps = $ClipFps; format = 'nv12-bt709-limited'; ffmpeg = $Ffmpeg
        ffmpegMtime = $ffmpegInfo.LastWriteTimeUtc.Ticks }
    $key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($cacheInfo | ConvertTo-Json -Compress))))
    $raw = Join-Path $CacheDir "$key.nv12"
    $dimensions = $Size.Split('x')
    $frameCount = [int][Math]::Round($ClipSeconds * $ClipFps, [MidpointRounding]::AwayFromZero)
    $expectedBytes = [long]$dimensions[0] * [long]$dimensions[1] * 3 / 2 * $frameCount
    if (!(Test-Path -LiteralPath $raw) -or (Get-Item -LiteralPath $raw).Length -ne $expectedBytes) {
        $partial = Join-Path $CacheDir "$key.$([guid]::NewGuid().ToString('N')).partial"
        $startText = $ClipStart.ToString([Globalization.CultureInfo]::InvariantCulture)
        $filter = "fps=$ClipFps,scale=$($dimensions[0]):$($dimensions[1]):out_color_matrix=bt709:out_range=tv"
        & $Ffmpeg -hide_banner -loglevel error -nostdin -ss $startText -i $Source -an -sn -dn -vf $filter -frames:v $frameCount -pix_fmt nv12 -f rawvideo -y $partial
        Check-Exit 'Footage predecode'
        if ((Get-Item -LiteralPath $partial).Length -ne $expectedBytes) { throw "Incomplete footage: expected $expectedBytes bytes; check the clip range. Partial file: $partial" }
        Move-Item -LiteralPath $partial -Destination $raw -Force
        Write-Json (Join-Path $CacheDir "$key.json") $cacheInfo
    }
    $invocation = Join-Path ([IO.Path]::GetFullPath($ResultsDir)) ("{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    [IO.Directory]::CreateDirectory($invocation) | Out-Null
    $gameExe = Join-Path $invocation 'r5apex.exe'
    Copy-Item -LiteralPath (Join-Path $crate 'target/release/fakegame.exe') -Destination $gameExe
    $revision = & git -C $repo rev-parse HEAD
    $runIndex = 0
    Write-Host "Results: $invocation"
    for ($iteration = 1; $iteration -le $Repeat; $iteration++) {
        foreach ($scenario in $Scenarios) {
            Assert-NoAditor
            $runIndex++
            $runDir = Join-Path $invocation ('{0:D3}-{1}' -f $runIndex, $scenario)
            $appData = Join-Path $runDir 'appdata'
            $recordings = Join-Path $runDir 'recordings'
            $watched = Join-Path $runDir 'watched'
            foreach ($dir in @($runDir, (Join-Path $appData 'Aditor'), $recordings, $watched)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
            $settings = @{ version = 2; onboardingDone = $true; lowPerfAsked = $true; language = 'en'
                telemetryEnabled = $false; autoUpdate = $false; autoAnalyze = ($scenario -eq 'record_analyze')
                watchFolders = @($watched); recording = @{ autoRecord = ($scenario -ne 'app_idle'); backend = 'builtin'; mode = 'session'
                    launchAtLogin = $false; closeToTray = $false; outputDir = $recordings; postAnalysis = 'none'
                    captureMethod = $CaptureMethod; preset = $Preset; openOnGameExit = $false } }
            Write-Json (Join-Path $appData 'Aditor/settings.json') $settings
            $config = @{ repo = $repo; captureMethod = $CaptureMethod; preset = $Preset; appDir = $appDir; runDir = $runDir; scenario = $scenario; appData = $appData
                recordings = $recordings; gameExe = $gameExe; raw = $raw; size = $Size; clipFps = $ClipFps
                loadPasses = $LoadPasses; fpsCap = $FpsCap; windowed = $Windowed; durationS = $DurationS
                warmupS = $WarmupS; startTimeoutS = $StartTimeoutS; finalizeTimeoutS = $FinalizeTimeoutS
                analyzeAtS = $AnalyzeAtS; analysisSource = $AnalysisSource
                analysisDestination = (Join-Path $watched 'Apex_bench_analysis.mp4'); ffmpeg = $Ffmpeg; source = $Source }
            $metadata = @{ status = 'running'; scenario = $scenario; repeat = $iteration; order = $runIndex
                started_at = [DateTime]::UtcNow.ToString('o'); git_revision = $revision
                capture_method = $CaptureMethod; preset = $Preset; clip = $cacheInfo; config = $config
                settings_overrides = $settings; cooldown_s = $CooldownS }
            Write-Json (Join-Path $runDir 'metadata.json') $metadata
            Write-Json (Join-Path $runDir 'config.json') $config
            Write-Host "Run $runIndex`: $scenario (repeat $iteration)"
            & node (Join-Path $PSScriptRoot 'bench-app.cjs') (Join-Path $runDir 'config.json')
            Check-Exit "Scenario $scenario"
            if ($CooldownS -gt 0) { Start-Sleep -Milliseconds ([int]($CooldownS * 1000)) }
        }
    }
    & $Python (Join-Path $PSScriptRoot 'summarize.py') $invocation
    Check-Exit 'Summary'
} finally {
    $env:PATH = $oldPath
    $env:ADITORREC_FFMPEG_DIR = $oldFfmpegDir
}
