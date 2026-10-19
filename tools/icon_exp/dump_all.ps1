$env:ADITOR_FFMPEG = 'D:\Develop\Aditor\build\ffmpeg\bin\ffmpeg.exe'
$env:ADITOR_FFPROBE = 'D:\Develop\Aditor\build\ffmpeg\bin\ffprobe.exe'
$env:PYTHONIOENCODING = 'utf-8'
$py = 'D:\Develop\Aditor\engine\.venv\Scripts\python.exe'
# Usage: $env:ICON_EXP_DIR = <working directory (about 13 GB)>; ./dump_all.ps1. Then run text_frames.py, feat_run.py (diag and s1), and ev.py/final_eval.py in order.
$sp = $env:ICON_EXP_DIR
$tools = $PSScriptRoot
$engine = (Resolve-Path "$PSScriptRoot\..\..\engine").Path
$V = [ordered]@{ EN = 'E:\Apex CLIP\English.mkv'; JA = 'E:\Apex CLIP\Japanese.mkv'; SC1 = 'E:\Apex CLIP\SC1.mkv'; SC2 = 'E:\Apex CLIP\SC2.mkv';
  TC = 'E:\Apex CLIP\test-TC.mp4'; ENG = 'E:\Apex CLIP\test-ENG.mp4'; JP = 'E:\Apex CLIP\test_JP.mp4' }
$jobs = @()
foreach ($k in $V.Keys) {
  $jobs += Start-Process -FilePath $py -ArgumentList @('-I', "$tools\dump.py", $engine, $k, "`"$($V[$k])`"", "$sp\frames") -NoNewWindow -PassThru -RedirectStandardOutput "$sp\dump_$k.log" -RedirectStandardError "$sp\dump_$k.err"
}
$jobs | ForEach-Object { "$($_.Id)" } | Set-Content "$sp\dump_pids.txt"
$jobs | Wait-Process
Get-Content "$sp\dump_*.log"
