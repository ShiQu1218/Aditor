param(
    [string]$FfmpegPath = "$PSScriptRoot/../build/ffmpeg/bin/ffmpeg.exe",
    [string]$ManifestPath = "$PSScriptRoot/ffmpeg-components.json",
    [switch]$Strict,
    [switch]$CheckPackage,
    [long]$MaxBinBytes = 40000000
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw 'Unsupported FFmpeg component manifest schema' }
foreach ($category in @('encoders', 'decoders', 'muxers', 'demuxers', 'filters', 'indevs', 'protocols', 'parsers', 'hwaccels', 'hwdevices')) {
    $names = @($manifest.components.$category | ForEach-Object { $_.names })
    if ($names.Count -eq 0) { throw "Empty or missing component category: $category" }
    $seen = @{}
    foreach ($name in $names) {
        if ($name -notmatch '^[a-z0-9_]+$' -or $seen.ContainsKey($name)) { throw "Invalid or duplicate ${category}: $name" }
        $seen[$name] = $true
    }
}

function Invoke-Ffmpeg([string[]]$Arguments) {
    # FFmpeg writes help/buildconf to stderr, even on success; Windows PowerShell
    # otherwise turns that into terminating NativeCommandError records.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $FfmpegPath -hide_banner @Arguments 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "FFmpeg $Arguments failed (exit $code): $output" }
    return $output
}

function Get-Required([string]$Category) {
    @($manifest.components.$Category | ForEach-Object { $_.names })
}

$missing = New-Object System.Collections.Generic.List[string]
$queries = @{
    encoders = '-encoders'; decoders = '-decoders'; muxers = '-muxers'
    demuxers = '-demuxers'; filters = '-filters'; indevs = '-devices'
    protocols = '-protocols'; hwdevices = '-hwaccels'
}
foreach ($category in $queries.Keys) {
    $output = Invoke-Ffmpeg @($queries[$category])
    $available = @{}
    foreach ($line in ($output -split '\r?\n')) {
        $names = $null
        switch ($category) {
            { $_ -in @('encoders', 'decoders') } { if ($line -match '^\s*[VAS][A-Z.]{5}\s+(\S+)\s') { $names = $Matches[1] } }
            'filters' { if ($line -match '^\s*[A-Z.]{2,3}\s+(\w+)\s+\S*->') { $names = $Matches[1] } }
            'muxers' { if ($line -match '^\s*[D ]E\s+(\S+)\s') { $names = $Matches[1] } }
            'demuxers' { if ($line -match '^\s*D[E ]\s+(\S+)\s') { $names = $Matches[1] } }
            'indevs' { if ($line -match '^\s*D[E ]\s+(\S+)\s') { $names = $Matches[1] } }
            default { if ($line -match '^\s*([a-z][a-z0-9_]*)\s*$') { $names = $Matches[1] } }
        }
        foreach ($name in ($names -split ',')) { if ($name) { $available[$name] = $true } }
    }
    foreach ($name in (Get-Required $category)) {
        if (-not $available.ContainsKey($name)) { $missing.Add("${category}: $name") }
    }
    if ($Strict -and $category -eq 'protocols') {
        foreach ($name in $available.Keys) {
            if ($name -notin (Get-Required 'protocols')) { $missing.Add("Unexpected protocol: $name") }
        }
    }
}

# -hwaccels lists device APIs, not per-codec accelerators. Decoder help verifies
# the compiled codec/device association without requiring that GPU to be present.
$decoderHelp = @{}
foreach ($accel in (Get-Required 'hwaccels')) {
    if ($accel -notmatch '^(.+)_(d3d11va2?|dxva2)$') { throw "Unknown hardware accelerator mapping: $accel" }
    $codec = $Matches[1]
    $device = $Matches[2] -replace 'd3d11va2$', 'd3d11va'
    if (-not $decoderHelp.ContainsKey($codec)) { $decoderHelp[$codec] = Invoke-Ffmpeg @('-h', "decoder=$codec") }
    $devices = ''
    if ($decoderHelp[$codec] -match 'Supported hardware devices:([^\r\n]+)') { $devices = $Matches[1] }
    if (($devices -split '\s+') -notcontains $device) { $missing.Add("hwaccels: $accel ($codec lacks $device)") }
}

$buildconf = Invoke-Ffmpeg @('-buildconf')
foreach ($forbidden in @('--enable-gpl', '--enable-nonfree', '--disable-x86asm')) {
    if ($buildconf -match [regex]::Escape($forbidden)) { $missing.Add("Forbidden configuration: $forbidden") }
}
foreach ($required in @('--enable-libdav1d', '--enable-libopenh264', '--enable-version3', '--enable-shared')) {
    if ($buildconf -notmatch [regex]::Escape($required)) { $missing.Add("Missing configuration: $required") }
}
if ($Strict) {
    foreach ($flag in @('--disable-network', '--disable-autodetect', '--disable-everything')) {
        if ($buildconf -notmatch [regex]::Escape($flag)) { $missing.Add("Missing minimal configuration: $flag") }
    }
    # FFmpeg has no -parsers option and does not expose the d3d11va/2 distinction
    # at runtime. The release includes the actual configure-generated definitions.
    $configPath = Join-Path (Split-Path -Parent (Split-Path -Parent $FfmpegPath)) 'build-config/config_components.h'
    if (-not (Test-Path -LiteralPath $configPath)) { throw "Missing compiled component definitions: $configPath" }
    $config = Get-Content -LiteralPath $configPath -Raw
    foreach ($category in @('parsers', 'hwaccels')) {
        $suffix = if ($category -eq 'parsers') { 'PARSER' } else { 'HWACCEL' }
        foreach ($name in (Get-Required $category)) {
            $define = 'CONFIG_' + $name.ToUpperInvariant() + '_' + $suffix
            if ($config -notmatch "(?m)^#define $define 1\s*$") { $missing.Add("Compiled configuration missing: $define") }
        }
    }
}
if ($CheckPackage) {
    $bin = Split-Path -Parent (Get-Item -LiteralPath $FfmpegPath).FullName
    $root = Split-Path -Parent $bin
    foreach ($file in @('bin/ffmpeg.exe', 'bin/ffprobe.exe', 'lib/avcodec.lib', 'lib/avformat.lib', 'lib/avutil.lib', 'include/libavcodec/avcodec.h', 'include/libavformat/avformat.h', 'include/libavutil/avutil.h', 'LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)) { $missing.Add("Package missing: $file") }
    }
    $bytes = (Get-ChildItem -LiteralPath $bin -File | Where-Object Extension -in @('.exe', '.dll') | Measure-Object Length -Sum).Sum
    Write-Host "FFmpeg bin: $bytes bytes (limit $MaxBinBytes)"
    if ($bytes -gt $MaxBinBytes) { $missing.Add("FFmpeg bin exceeds size limit: $bytes > $MaxBinBytes") }
}
if ($missing.Count) { throw "FFmpeg verification failed:`n$($missing -join "`n")" }
Write-Host 'FFmpeg component, hardware API and LGPL configuration verification passed.'
