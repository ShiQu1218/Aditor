# Monitor an existing Aditor process tree without starting or stopping recording.
[CmdletBinding()]
param(
    [ValidateRange(1, 2147483647)][int]$ProcessId,
    [ValidateRange(1, 3600)][int]$IntervalSeconds = 1,
    [ValidateRange(0, 86400)][int]$DurationSeconds = 0,
    [string]$OutputDir,
    [switch]$GpuCounters
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$processors = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if ($processors -lt 1) { throw 'Could not determine the logical processor count.' }

function Get-ProcessSnapshot {
    @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath,
        CreationDate, KernelModeTime, UserModeTime, WorkingSetSize, PrivatePageCount,
        ReadTransferCount, WriteTransferCount)
}

$snapshot = Get-ProcessSnapshot
if ($ProcessId) {
    $target = @($snapshot | Where-Object { $_.ProcessId -eq $ProcessId })
} else {
    $developmentExe = Join-Path $root 'app\node_modules\electron\dist\electron.exe'
    $candidates = @($snapshot | Where-Object {
        $_.Name -ieq 'Aditor.exe' -or $_.ExecutablePath -ieq $developmentExe
    })
    # The packaged Python engine is also named aditor.exe. Select the top-level app only.
    $candidateIds = @($candidates | ForEach-Object { [int]$_.ProcessId })
    $target = @($candidates | Where-Object { $candidateIds -notcontains [int]$_.ParentProcessId })
}
if ($target.Count -ne 1) {
    throw 'Expected one Aditor instance. Start Aditor first, or specify its main process with -ProcessId.'
}
$targetId = [int]$target[0].ProcessId
$targetCreated = $target[0].CreationDate
if (-not $OutputDir) {
    $session = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $OutputDir = Join-Path $root "out/resource-monitor/$session"
}
$directory = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$processCsv = Join-Path $directory 'processes.csv'
$totalCsv = Join-Path $directory 'totals.csv'
if ((Test-Path -LiteralPath $processCsv) -or (Test-Path -LiteralPath $totalCsv)) {
    throw 'Output CSV files already exist. Choose a new -OutputDir.'
}

$previous = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
$gpuEnabled = [bool]$GpuCounters
Write-Host "Monitoring PID $targetId and descendants. Ctrl+C stops monitoring."
Write-Host "CSV output: $directory"
try {
    while ($true) {
        $sampleStarted = $clock.Elapsed.TotalSeconds
        $snapshot = Get-ProcessSnapshot
        $now = $clock.Elapsed.TotalSeconds
        $timestamp = [DateTimeOffset]::Now.ToString('o')
        $main = @($snapshot | Where-Object {
            $_.ProcessId -eq $targetId -and $_.CreationDate -eq $targetCreated
        })
        if ($main.Count -eq 0) {
            Write-Host 'Aditor exited. Monitoring stopped.'
            break
        }
        $selected = @{ $targetId = $true }
        do {
            $added = $false
            foreach ($item in $snapshot) {
                $id = [int]$item.ProcessId
                if (-not $selected.ContainsKey($id) -and $selected.ContainsKey([int]$item.ParentProcessId)) {
                    $selected[$id] = $true
                    $added = $true
                }
            }
        } while ($added)

        $gpu = @{}
        $gpuAvailable = $false
        if ($gpuEnabled) {
            try {
                $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
                $gpuAvailable = $engines.Count -gt 0
                foreach ($engine in $engines) {
                    if ($engine.Name -match '^pid_(\d+)_.*_engtype_(.+)$') {
                        $id = [int]$Matches[1]
                        $kind = $Matches[2]
                        if ($selected.ContainsKey($id)) {
                            if (-not $gpu.ContainsKey($id)) { $gpu[$id] = @{ All = 0.0; Encode = 0.0 } }
                            $gpu[$id].All += [double]$engine.UtilizationPercentage
                            if ($kind -eq 'VideoEncode') { $gpu[$id].Encode += [double]$engine.UtilizationPercentage }
                        }
                    }
                }
            } catch {
                Write-Warning "GPU counters unavailable; continuing with CPU, memory and I/O. $($_.Exception.Message)"
                $gpuEnabled = $false
            }
        }

        $next = @{}
        $rows = @(foreach ($item in $snapshot) {
            $id = [int]$item.ProcessId
            if (-not $selected.ContainsKey($id)) { continue }
            $key = "${id}:$($item.CreationDate.Ticks)"
            $cpuTime = ([double]$item.KernelModeTime + [double]$item.UserModeTime) / 1e7
            $cpu = $null
            $read = $null
            $write = $null
            if ($previous.ContainsKey($key)) {
                $last = $previous[$key]
                $elapsed = $now - $last.Time
                $cpu = [math]::Round([math]::Max(0.0, ($cpuTime - $last.Cpu) / $elapsed / $processors * 100), 3)
                $read = [math]::Round([math]::Max(0.0, ([double]$item.ReadTransferCount - $last.Read) / $elapsed / 1MB), 3)
                $write = [math]::Round([math]::Max(0.0, ([double]$item.WriteTransferCount - $last.Write) / $elapsed / 1MB), 3)
            }
            $next[$key] = @{ Time = $now; Cpu = $cpuTime; Read = [double]$item.ReadTransferCount; Write = [double]$item.WriteTransferCount }
            [pscustomobject][ordered]@{
                Timestamp = $timestamp
                ElapsedSeconds = [math]::Round($now, 3)
                ProcessId = $id
                ParentProcessId = [int]$item.ParentProcessId
                Name = $item.Name
                CpuPercent = $cpu
                WorkingSetMiB = [math]::Round([double]$item.WorkingSetSize / 1MB, 3)
                PrivateMiB = [math]::Round([double]$item.PrivatePageCount / 1MB, 3)
                IOReadMiBps = $read
                IOWriteMiBps = $write
                GpuEngineSumPercent = $(if ($gpuAvailable) { if ($gpu.ContainsKey($id)) { $gpu[$id].All } else { 0 } } else { $null })
                GpuEncodeSumPercent = $(if ($gpuAvailable) { if ($gpu.ContainsKey($id)) { $gpu[$id].Encode } else { 0 } } else { $null })
            }
        })
        $previous = $next
        $total = [ordered]@{ Timestamp = $timestamp; ElapsedSeconds = [math]::Round($now, 3); ProcessCount = $rows.Count }
        foreach ($field in @('CpuPercent', 'WorkingSetMiB', 'PrivateMiB', 'IOReadMiBps', 'IOWriteMiBps', 'GpuEngineSumPercent', 'GpuEncodeSumPercent')) {
            $values = @($rows | Where-Object { $null -ne $_.$field })
            $total[$field] = $(if ($values.Count) { [math]::Round(($values | Measure-Object -Property $field -Sum).Sum, 3) } else { $null })
        }
        $rows | Export-Csv -LiteralPath $processCsv -NoTypeInformation -Encoding UTF8 -Append
        [pscustomobject]$total | Export-Csv -LiteralPath $totalCsv -NoTypeInformation -Encoding UTF8 -Append
        Write-Host ('{0:HH:mm:ss}  Processes={1}  CPU={2}%  WorkingSet={3} MiB  Write={4} MiB/s' -f (Get-Date), $rows.Count, $total.CpuPercent, $total.WorkingSetMiB, $total.IOWriteMiBps)
        if ($DurationSeconds -gt 0 -and $clock.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
        $delay = [math]::Max(0.0, $IntervalSeconds - ($clock.Elapsed.TotalSeconds - $sampleStarted))
        if ($DurationSeconds -gt 0) { $delay = [math]::Min([double]$delay, [math]::Max(0.0, $DurationSeconds - $clock.Elapsed.TotalSeconds)) }
        if ($delay -gt 0) { Start-Sleep -Milliseconds ([int]($delay * 1000)) }
    }
} finally {
    $clock.Stop()
    Write-Host "Monitoring finished. CSV output: $directory"
}
