param(
    [string]$Engine = "$PSScriptRoot\..\build\engine\aditor\aditor.exe",
    [string]$Templates = "$PSScriptRoot\..\templates"
)

$ErrorActionPreference = 'Stop'
# Rust release executable, staged by build.ps1; no runtime or sidecar libraries required.
if (-not (Test-Path -LiteralPath $Engine)) { throw "Rust engine executable not found: $Engine" }
$profile = Get-Content -Raw -LiteralPath (Join-Path $Templates 'icons\profile.json') | ConvertFrom-Json
$banner = $profile.capture_rois.banner
$spec = $profile.capture_rois.spec
$feed = $profile.capture_rois.killfeed
$slotBytes = ([int]$banner[2] * [int]$banner[3] * 3 + [int]$spec[2] * [int]$spec[3] * 3 +
    640 * 360 + [int]$feed[2] * [int]$feed[3] * 3 + 32 + 7) -band -8
$rust = Get-Content -Raw -LiteralPath "$PSScriptRoot\..\recorder\src\shm.rs"
if ($rust -notmatch 'pub const SHM_VERSION: u32 = (\d+);') { throw 'Recorder shared-memory version not found' }
$version = [uint32]$Matches[1]
$name = 'Local\aditor-build-check-' + [guid]::NewGuid().ToString('N')
$mapping = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew($name, 64 + 16 * $slotBytes)
$view = $null
$process = $null
try {
    $view = $mapping.CreateViewAccessor()
    $magic = [Text.Encoding]::ASCII.GetBytes('APXSHM01')
    $view.WriteArray(0, $magic, 0, $magic.Length)
    $fields = @($version, 16, $slotBytes, $banner[2], $banner[3], $spec[2], $spec[3], 640, 360, $feed[2])
    for ($i = 0; $i -lt $fields.Count; $i++) { $view.Write(8 + 4 * $i, [uint32]$fields[$i]) }
    $view.Write(56, [uint32]$feed[3])
    $view.Write(64, [uint64]1)
    $view.Write(80, [uint32]1)
    $view.Write(64 + $slotBytes - 8, [uint64]1)
    $view.Write(48, [uint64]1)
    $view.Flush()

    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = [IO.Path]::GetFullPath($Engine)
    $icons = [IO.Path]::GetFullPath((Join-Path $Templates 'icons'))
    $scene = [IO.Path]::GetFullPath((Join-Path $Templates 'scene'))
    $info.Arguments = 'live --shm "' + $name + '" --profile-dir "' + $icons + '" --scene-dir "' + $scene + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine('{"cmd":"stop"}')
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { throw 'Live engine compatibility check timed out' }
    $lines = @($stdout.Result -split '\r?\n' | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    if ($process.ExitCode -ne 0 -or @($lines | Where-Object { $_.ev -eq 'error' }).Count -gt 0) {
        throw "Live engine compatibility check failed: $($stdout.Result) $($stderr.Result)"
    }
    $ready = @($lines | Where-Object { $_.ev -eq 'ready' })
    $stats = @($lines | Where-Object { $_.ev -eq 'stats' -and $_.frames -eq 1 })
    $final = @($lines | Where-Object { $_.ev -eq 'snapshot' -and $_.final })
    if ($ready.Count -ne 1 -or $stats.Count -eq 0 -or $final.Count -ne 1) { throw 'Live engine did not process the test frame and finalize' }
    Write-Host "Live engine shared-memory v$version check passed (one frame processed)."
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    if ($view) { $view.Dispose() }
    $mapping.Dispose()
}
