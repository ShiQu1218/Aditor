# Heuristic memory growth screening; allocation traces are required to prove a leak.
[CmdletBinding()]
param(
    [string]$InputDir,
    [string]$OutputDir,
    [ValidateRange(1, 2147483647)][int]$ProcessId,
    [ValidateRange(1, 86400)][int]$DurationSeconds = 3600,
    [ValidateRange(1, 30)][int]$IntervalSeconds = 5,
    [ValidateRange(0, 60)][int]$WarmupMinutes = 5,
    [ValidateRange(20, 1440)][int]$MinimumMinutes = 20,
    [ValidateRange(0.001, 100000)][double]$GrowthMiB = 32,
    [ValidateRange(0.001, 100000)][double]$SlopeMiBPerMinute = 1
)

$ErrorActionPreference = 'Stop'
$culture = [Globalization.CultureInfo]::InvariantCulture
if ($InputDir -and $OutputDir) { throw 'Use -InputDir to analyze an existing session, or -OutputDir to collect a new one.' }
if (-not $InputDir) {
    if (-not $OutputDir) {
        $session = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $OutputDir = Join-Path $PSScriptRoot "../out/resource-monitor/memory-$session"
    }
    $monitor = @{ OutputDir = $OutputDir; DurationSeconds = $DurationSeconds; IntervalSeconds = $IntervalSeconds }
    if ($ProcessId) { $monitor.ProcessId = $ProcessId }
    & (Join-Path $PSScriptRoot 'monitor-resources.ps1') @monitor
    $InputDir = $OutputDir
}
$directory = (Resolve-Path -LiteralPath $InputDir).Path
$csv = Join-Path $directory 'processes.csv'
if (-not (Test-Path -LiteralPath $csv -PathType Leaf)) { throw "Missing process samples: $csv" }

function Read-Number([string]$Value, [string]$Field) {
    $number = 0.0
    if (-not [double]::TryParse($Value, [Globalization.NumberStyles]::Float, $culture, [ref]$number) -or
        [double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0) {
        throw "Invalid $Field value in processes.csv: '$Value'"
    }
    return $number
}

function Get-Median($Values) {
    $sorted = @($Values | Sort-Object)
    $middle = [int][math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2) { return [double]$sorted[$middle] }
    return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2
}

function Get-Slope($Points) {
    $meanX = ($Points | Measure-Object Minute -Average).Average
    $meanY = ($Points | Measure-Object Memory -Average).Average
    $numerator = 0.0
    $denominator = 0.0
    foreach ($point in $Points) {
        $dx = $point.Minute - $meanX
        $numerator += $dx * ($point.Memory - $meanY)
        $denominator += $dx * $dx
    }
    if ($denominator -eq 0) { return 0.0 }
    return $numerator / $denominator
}

function Measure-Trend($Samples, [string]$Name, [string]$Id, [string]$StartedAt, [int]$Segment) {
    $ordered = @($Samples | Sort-Object Time)
    $firstTime = $ordered[0].Time
    $lastTime = $ordered[-1].Time
    $afterWarmup = @($ordered | Where-Object { $_.Time -ge $firstTime + $WarmupMinutes * 60 })
    $points = @($afterWarmup | Group-Object { [int][math]::Floor(($_.Time - $firstTime) / 60) } | ForEach-Object {
        # Require multiple observations across most of each minute, excluding sparse/partial buckets.
        $bucket = @($_.Group | Sort-Object Time)
        if ($bucket.Count -ge 3 -and $bucket[-1].Time - $bucket[0].Time -ge 40) {
            [pscustomobject]@{
                Minute = ($bucket | Measure-Object Time -Average).Average / 60
                Memory = Get-Median @($bucket | ForEach-Object { $_.Memory })
            }
        }
    } | Sort-Object Minute)
    $result = [ordered]@{
        Name = $Name; ProcessId = $Id; ProcessStartedAt = $StartedAt; Segment = $Segment
        Status = 'InsufficientData'; Samples = $ordered.Count; ValidMinuteWindows = $points.Count
        ObservedMinutes = [math]::Round(($lastTime - $firstTime) / 60, 2)
        GrowthMiB = $null; SlopeMiBPerMinute = $null; LateSlopeMiBPerMinute = $null
        RisingWindowFraction = $null
    }
    if ($afterWarmup.Count -lt 2 -or $points.Count -lt $MinimumMinutes -or
        $afterWarmup[-1].Time - $afterWarmup[0].Time -lt $MinimumMinutes * 60) {
        return [pscustomobject]$result
    }
    $growth = (Get-Median @($points[-3..-1] | ForEach-Object { $_.Memory })) -
        (Get-Median @($points[0..2] | ForEach-Object { $_.Memory }))
    $slope = Get-Slope $points
    $lateStart = [int][math]::Floor($points.Count / 2)
    $lateSlope = Get-Slope @($points[$lateStart..($points.Count - 1)])
    $rising = 0
    for ($index = 1; $index -lt $points.Count; $index++) {
        if ($points[$index].Memory - $points[$index - 1].Memory -gt 0.1) { $rising++ }
    }
    $fraction = $rising / [double]($points.Count - 1)
    $result.Status = 'NoSustainedGrowthDetected'
    if ($growth -ge $GrowthMiB -and $slope -ge $SlopeMiBPerMinute -and
        $lateSlope -ge $SlopeMiBPerMinute * 0.5 -and $fraction -ge 0.7) {
        $result.Status = 'SuspectedLeak'
    }
    $result.GrowthMiB = [math]::Round($growth, 3)
    $result.SlopeMiBPerMinute = [math]::Round($slope, 3)
    $result.LateSlopeMiBPerMinute = [math]::Round($lateSlope, 3)
    $result.RisingWindowFraction = [math]::Round($fraction, 3)
    return [pscustomobject]$result
}

$groups = @{}
$legacy = $false
$sampleCount = 0
Import-Csv -LiteralPath $csv | ForEach-Object {
    $row = $_
    foreach ($field in @('ElapsedSeconds', 'PrivateMiB', 'ProcessId', 'Name')) {
        if ($null -eq $row.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace($row.$field)) {
            throw "Missing $field in processes.csv."
        }
    }
    $time = Read-Number $row.ElapsedSeconds 'ElapsedSeconds'
    $memory = Read-Number $row.PrivateMiB 'PrivateMiB'
    $id = Read-Number $row.ProcessId 'ProcessId'
    if ($id -lt 1 -or $id -gt [int]::MaxValue -or $id -ne [math]::Floor($id)) { throw 'Invalid process ID.' }
    $startedAt = [string]$row.ProcessStartedAt
    if (-not $startedAt) { $legacy = $true }
    $key = "$id|$($row.Name)|$startedAt"
    if (-not $groups.ContainsKey($key)) {
        $groups[$key] = @{ Name = $row.Name; Id = [string]$row.ProcessId; StartedAt = $startedAt; Samples = [Collections.Generic.List[object]]::new() }
    }
    $groups[$key].Samples.Add([pscustomobject]@{ Time = $time; Memory = $memory })
    $sampleCount++
}
if ($sampleCount -eq 0) { throw 'No process samples found.' }
$results = @(foreach ($group in $groups.Values) {
    $samples = @($group.Samples | Sort-Object Time)
    $steps = @(for ($index = 1; $index -lt $samples.Count; $index++) {
        $step = $samples[$index].Time - $samples[$index - 1].Time
        if ($step -le 0) { throw "Duplicate sample time for PID $($group.Id)." }
        $step
    })
    $maximumGap = 30.0
    if ($steps.Count) { $maximumGap = [math]::Max(30.0, (Get-Median $steps) * 3) }
    $segment = [Collections.Generic.List[object]]::new()
    $segmentNumber = 1
    for ($index = 0; $index -lt $samples.Count; $index++) {
        if ($index -gt 0 -and $samples[$index].Time - $samples[$index - 1].Time -gt $maximumGap) {
            Measure-Trend $segment $group.Name $group.Id $group.StartedAt $segmentNumber
            $segment = [Collections.Generic.List[object]]::new()
            $segmentNumber++
        }
        $segment.Add($samples[$index])
    }
    Measure-Trend $segment $group.Name $group.Id $group.StartedAt $segmentNumber
})
$results = @($results | Sort-Object Name, ProcessId, ProcessStartedAt, Segment)
$suspects = @($results | Where-Object Status -eq 'SuspectedLeak')
$evaluated = @($results | Where-Object Status -ne 'InsufficientData')
$status = if ($suspects.Count) { 'SuspectedLeak' } elseif ($evaluated.Count) { 'NoSustainedGrowthDetected' } else { 'InsufficientData' }
$report = [ordered]@{
    Status = $status
    Metric = 'Private committed memory (MiB), not resident RAM'
    WarmupMinutes = $WarmupMinutes; MinimumMinutes = $MinimumMinutes
    GrowthThresholdMiB = $GrowthMiB; SlopeThresholdMiBPerMinute = $SlopeMiBPerMinute
    LegacyProcessIdentity = $legacy
    EvaluatedSegments = $evaluated.Count; InsufficientSegments = $results.Count - $evaluated.Count
    Limitations = @(
        'Heuristic screening only. A positive result can be cache/workload growth; a negative result does not rule out leaks.',
        'Compare repeated equivalent recording/idle cycles. No recording phases or allocation stacks are collected.',
        'Each process lifetime and continuous sampling segment is analyzed separately. Short-lived processes are not cleared by the overall status.',
        'Older CSVs without ProcessStartedAt cannot reliably distinguish reused PIDs. GPU memory is not measured.'
    )
    Processes = $results
}
$reportPath = Join-Path $directory ('memory-leak-' + [guid]::NewGuid().ToString('N') + '.json')
$stream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try {
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    try { $writer.WriteLine(($report | ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
} finally { $stream.Dispose() }
Write-Host "Memory trend result: $status"
$results | Format-Table Name, ProcessId, Segment, Status, ObservedMinutes, GrowthMiB, SlopeMiBPerMinute -AutoSize | Out-Host
if ($legacy) { Write-Warning 'Legacy CSV: process start times are missing; PID reuse cannot be ruled out.' }
Write-Host "Report: $reportPath"
