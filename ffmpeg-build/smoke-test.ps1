param([Parameter(Mandatory = $true)][string]$FfmpegPath)
$ErrorActionPreference = 'Stop'
$FfmpegPath = (Get-Item -LiteralPath $FfmpegPath).FullName
$probe = Join-Path (Split-Path -Parent $FfmpegPath) 'ffprobe.exe'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('aditor-ffmpeg-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null

function Invoke-FF([string[]]$Arguments) {
    & $FfmpegPath -hide_banner -v error -nostdin -y @Arguments
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg smoke failed ($LASTEXITCODE): $Arguments" }
}
try {
    Push-Location $temp
    try {
        # Exercise the final software fallback, lavfi, AAC, MP4 and swscale.
        Invoke-FF @('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:v', 'libopenh264', '-b:v', '2M', '-allow_skip_frames', '0', '-g', '30', '-c:a', 'aac', '-shortest', 'source.mp4')
        Invoke-FF @('-i', 'source.mp4', '-frames:v', '1', '-vf', 'scale=160:90', 'thumb.jpg')
        if ((Get-Item thumb.jpg).Length -eq 0) { throw 'Empty JPEG thumbnail' }
        # Mirror the engine's complex graph and verify actual raw output length.
        Invoke-FF @('-i', 'source.mp4', '-filter_complex', '[0:v]fps=4,scale=320:240,split[a][b];[a]crop=160:60:0:0[a1];[b]crop=80:60:0:60,pad=160:ih[b1];[a1][b1]vstack', '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'frames.raw')
        if ((Get-Item frames.raw).Length -ne (8 * 160 * 120 * 3)) { throw 'Wrong engine frame count or pixel format' }
        Invoke-FF @('-i', 'source.mp4', '-c:v', 'copy', '-an', 'silent.mp4')
        Invoke-FF @('-ss', '0.25', '-i', 'silent.mp4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.5', '-map', '0:v:0', '-map', '1:a:0', '-vf', 'scale=320:240,pad=320:240,fps=30,format=yuv420p', '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-shortest', 'segment.mov')
        Set-Content -LiteralPath list.txt -Encoding ascii -Value @("file 'segment.mov'", "file 'segment.mov'")
        Invoke-FF @('-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-movflags', '+faststart', 'concat.mp4')
        Invoke-FF @('-i', 'concat.mp4', '-c', 'copy', '-metadata', 'aditor_game=apex', '-movflags', '+faststart+use_metadata_tags', 'final.mp4')
        Invoke-FF @('-i', 'final.mp4', '-f', 'null', '-')
        Invoke-FF @('-i', 'final.mp4', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', 'audio-s16.raw')
        Invoke-FF @('-i', 'final.mp4', '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'audio-f32.raw')
        if ((Get-Item audio-s16.raw).Length -eq 0 -or (Get-Item audio-f32.raw).Length -eq 0) { throw 'Empty decoded audio samples' }
        $json = & $probe -v error -show_entries 'stream=codec_name:format_tags=aditor_game' -of json final.mp4 | Out-String
        if ($LASTEXITCODE -ne 0) { throw 'ffprobe failed' }
        $info = $json | ConvertFrom-Json
        if ($info.streams.codec_name -notcontains 'h264' -or $info.streams.codec_name -notcontains 'aac' -or $info.format.tags.aditor_game -ne 'apex') { throw 'Final media codecs or metadata changed' }
        # FFV1/Matroska and the VFR fixture filters must also survive pruning.
        Invoke-FF @('-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,0.5)',select='not(eq(mod(n,7),3))',setpts=PTS", '-c:v', 'ffv1', 'scene.mkv')
        Invoke-FF @('-i', 'scene.mkv', '-f', 'null', '-')
    } finally { Pop-Location }
    Write-Host 'FFmpeg software fallback, thumbnail, engine graph, silent MOV/concat, metadata and VFR smoke checks passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe smoke cleanup path: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
