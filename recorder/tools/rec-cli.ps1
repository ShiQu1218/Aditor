# Manual recording and measurement: run cargo build --release, then set ADITORREC_FFMPEG_DIR and add FFmpeg bin to PATH.
# Example: ./tools/rec-cli.ps1 -TargetPid 1234 -Seconds 60 -NoMicrophone
# Compare capture methods with -Capture wgc|dda; -GpuCounters also samples GPU engine utilization for aditorrec and dwm once per second.
[CmdletBinding()]
param(
    [ValidateSet('wgc', 'dda')][string]$Capture = 'wgc',
    [switch]$GpuCounters,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$TargetPid,
    [ValidateRange(1, 86400)][int]$Seconds = 10,
    [string]$ExePath = (Join-Path $PSScriptRoot '../target/release/aditorrec.exe'),
    [string]$OutputDir,
    [ValidateSet('hevc', 'h264', 'av1')][string]$Codec = 'hevc',
    [string]$Encoder = 'auto',
    [ValidateRange(1, 144)][int]$Fps = 60,
    [ValidateRange(0, 16384)][int]$Height = 0,
    [ValidateRange(1, 1000000)][int]$BitrateKbps = 40000,
    [string]$RenderDevice = 'default',
    [string]$CaptureDevice = 'default',
    [ValidateRange(0, 10)][float]$MicGain = 1,
    [int[]]$Banner = @(220, 240, 96, 48),
    [int[]]$Spectator = @(960, 540, 96, 48),
    [switch]$NoMicrophone,
    [switch]$NoAudio,
    [switch]$NoEncode
)
$ErrorActionPreference = 'Stop'
if ($Banner.Count -ne 4 -or $Spectator.Count -ne 4) { throw 'Each ROI must contain four integers: x, y, w, and h.' }
$executable = (Resolve-Path -LiteralPath $ExePath).Path
# The recorder dynamically links FFmpeg; it exits before producing output if the DLLs are missing.
$ffmpegRoot = if ($env:ADITORREC_FFMPEG_DIR) { $env:ADITORREC_FFMPEG_DIR } else { Join-Path $PSScriptRoot '../../build/ffmpeg' }
$ffmpegBin = Join-Path $ffmpegRoot 'bin'
if (Test-Path -LiteralPath $ffmpegBin) { $env:PATH = (Resolve-Path -LiteralPath $ffmpegBin).Path + ';' + $env:PATH }
$sessionId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot "../target/recordings/$sessionId" }
$directory = [IO.Path]::GetFullPath($OutputDir)
$processors = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if ($processors -lt 1) { throw 'Could not determine the system logical processor count.' }
$video = $null
if (-not $NoEncode) { $video = @{ codec = $Codec; encoder = $Encoder; fps = $Fps; height = $Height; bitrate_kbps = $BitrateKbps } }
$audio = $null
if (-not $NoAudio -and -not $NoEncode) { $audio = @{ render = $RenderDevice; capture = $CaptureDevice; mic_gain = $MicGain; mic_enabled = -not $NoMicrophone } }
$request = @{ id = 1; cmd = 'start'; pid = $TargetPid; session_dir = $directory; session_id = $sessionId; encode = $video; audio = $audio; frames = @{ banner = $Banner; spec = $Spectator; base = @(1920, 1080) }; capture = $Capture }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $executable
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WindowStyle = 'Hidden'
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$lines = [Collections.Generic.List[string]]::new()
$events = [Collections.Generic.List[object]]::new()
$launched = $false
$script:pendingLine = $null
function Read-RecorderLine([datetime]$Deadline) {
    if (-not $script:pendingLine) { $script:pendingLine = $process.StandardOutput.ReadLineAsync() }
    while (-not $script:pendingLine.Wait(50)) {
        if ([datetime]::UtcNow -gt $Deadline) { throw 'Timed out waiting for the recorder response.' }
    }
    $line = $script:pendingLine.GetAwaiter().GetResult()
    $script:pendingLine = $null
    if ($null -eq $line) { throw 'The recorder closed stdout unexpectedly.' }
    $lines.Add($line)
    $value = $line | ConvertFrom-Json
    $events.Add($value)
    if ($value.ev -eq 'error' -or ($null -ne $value.ok -and -not $value.ok)) { throw "Recording failed [$($value.code)]: $($value.message)" }
    return $value
}
try {
    if (-not $process.Start()) { throw 'Could not start the recorder.' }
    $launched = $true
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 6 -Compress))
    $started = $null
    $ack = $false
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    while (-not $ack -or -not $started) {
        $value = Read-RecorderLine $deadline
        if ($value.ev -eq 'started') { $started = $value }
        if ($value.id -eq 1) { $ack = $true }
    }
    $gpuJob = $null
    if ($GpuCounters) {
        # Sample in a background job so Get-Counter's one-second interval does not block stdout reads.
        $dwm = @(Get-Process dwm -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        $gpuJob = Start-Job -ArgumentList $process.Id, $dwm, ([math]::Max(1, $Seconds - 3)) -ScriptBlock {
            param($recorder, $dwm, $count)
            $watch = @{ aditorrec = @($recorder); dwm = @($dwm) }
            $sums = @{}
            $samples = @(Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples $count -ErrorAction SilentlyContinue)
            foreach ($sample in $samples) {
                foreach ($counter in $sample.CounterSamples) {
                    if ($counter.InstanceName -notmatch '^pid_(\d+)_.*_engtype_(.+)$') { continue }
                    $owner = [int]$Matches[1]
                    $engine = $Matches[2]
                    foreach ($name in $watch.Keys) {
                        if ($watch[$name] -contains $owner) { $sums["$name/$engine"] = [double]$sums["$name/$engine"] + $counter.CookedValue }
                    }
                }
            }
            $result = [ordered]@{ samples = $samples.Count }
            foreach ($key in ($sums.Keys | Sort-Object)) { $result[$key] = [math]::Round($sums[$key] / [math]::Max(1, $samples.Count), 2) }
            [pscustomobject]$result
        }
    }
    $process.Refresh()
    $cpuStart = $process.TotalProcessorTime.TotalSeconds
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
        if (-not $script:pendingLine) { $script:pendingLine = $process.StandardOutput.ReadLineAsync() }
        if ($script:pendingLine.IsCompleted) { $null = Read-RecorderLine ([datetime]::UtcNow.AddSeconds(1)) }
        else { Start-Sleep -Milliseconds 20 }
    }
    $elapsed = $timer.Elapsed.TotalSeconds
    $process.Refresh()
    $cpu = ($process.TotalProcessorTime.TotalSeconds - $cpuStart) / $elapsed / $processors * 100
    $gpu = $null
    if ($gpuJob) { $gpu = Receive-Job $gpuJob -Wait -AutoRemoveJob | Select-Object -Property * -ExcludeProperty PSComputerName, RunspaceId, PSShowComputerName }
    $process.StandardInput.WriteLine('{"id":2,"cmd":"stop"}')
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    do { $value = Read-RecorderLine $deadline } while ($value.id -ne 2)
    $process.Refresh()
    $peak = $process.PeakWorkingSet64
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(15000)) { throw 'The recorder did not exit after EOF.' }
    $log = $stderr.GetAwaiter().GetResult()
    if ($log) { Write-Warning $log }
    if ($process.ExitCode -ne 0) { throw "Recorder exit code: $($process.ExitCode)" }
    $index = @()
    if (-not $NoEncode) { $index = @(Get-Content -LiteralPath (Join-Path $directory 'index.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json }) }
    $stats = @($events | Where-Object { $_.ev -eq 'stats' }) | Select-Object -Last 1
    $result = [ordered]@{
        directory = $directory; seconds = $elapsed; capture = $Capture; encoder = $started.encoder
        width = $started.width; height = $started.height; fps = $started.fps
        cpu_percent_machine = $cpu; logical_processors = $processors; peak_working_set_bytes = $peak
        dropped = $stats.dropped; small_dropped = $stats.small_dropped
        segment_bytes = @($index | ForEach-Object { $_.bytes })
        gpu_percent = $gpu
    }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllLines((Join-Path $directory 'recorder-ipc.jsonl'), $lines, $utf8)
    $json = $result | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $directory 'measurement.json'), $json, $utf8)
    $json
}
finally {
    if ($gpuJob) { Remove-Job $gpuJob -Force -ErrorAction SilentlyContinue }
    if ($launched -and -not $process.HasExited) {
        # EOF lets the native process shut down cleanly; terminate the child process only if it times out.
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); $process.WaitForExit() }
    }
    $process.Dispose()
}
