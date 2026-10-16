"""把影片以引擎同一條解碼管線（4 fps、1080p、banner_roi）解出的橫幅區存成 raw uint8（N×180×800×3）。
用法：dump.py <engine_dir> <label> <video> <outdir>"""
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from apexhl.decode import FrameStream
from apexhl.probe import probe
from apexhl.profile import load_profile

lab, video, out = sys.argv[2], sys.argv[3], Path(sys.argv[4])
out.mkdir(parents=True, exist_ok=True)
prof = load_profile(Path(sys.argv[1]).parent / "templates" / "en")
info = probe(video)
t0 = time.time(); n = 0
with open(out / f"{lab}.u8", "wb") as f:
    for t, banner, spec in FrameStream(video, prof, hwaccel=True, codec=info.codec):
        f.write(banner.tobytes()); n += 1
(out / f"{lab}.json").write_text(f'{{"n": {n}, "h": 180, "w": 800, "fps": 4, "duration": {info.duration}}}')
print(lab, n, round(time.time() - t0, 1), "s", flush=True)
