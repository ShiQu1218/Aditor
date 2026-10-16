"""測試共用工具：合成影片產生器與 fixture 路徑。"""
import functools
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"
ICON_DIR = REPO / "templates" / "icons"
LANGS = ("zh-TW", "en", "ja")  # fixture 的來源語言（只是素材分類；引擎本身與語言無關）


def _ffmpeg() -> str:
    from apexhl import ffbin
    return ffbin.ffmpeg()


def make_video(tmp_path, name, duration, *, start_time=0.0, vfr=False, marks=(), overlay=None):
    """用 ffmpeg testsrc2 產生 1920x1080、60fps、-g 60 的 H.264 影片。

    marks：(t_start, t_end) 清單，在這些時間於 banner 區域畫實心白框。
    start_time：以 -output_ts_offset 達成。vfr：丟格並抖動 pts 產生可變幀率。
    overlay：(png_path, [(t_start, t_end), ...])，於 (560,700) 疊上 PNG。
    """
    out = Path(tmp_path) / name
    filters = []
    for a, b in marks:
        filters.append(f"drawbox=x=400:y=600:w=1120:h=350:color=white:t=fill:enable='between(t,{a},{b})'")
    inputs = ["-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=60:duration={duration}"]
    chain = ",".join(filters) if filters else "null"
    if vfr:
        chain += ",select='not(eq(mod(n,7),3))',setpts='PTS+(0.006*sin(N*7))/TB'"
    fc = f"[0:v]{chain}[v0]"
    last = "[v0]"
    if overlay:
        png, spans = overlay
        inputs += ["-loop", "1", "-i", str(png)]
        en = "+".join(f"between(t,{a},{b})" for a, b in spans)
        fc += f";[v0][1:v]overlay=x=560:y=700:enable='{en}':shortest=1[v1]"
        last = "[v1]"
    cmd = [_ffmpeg(), "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", last,
           "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-pix_fmt", "yuv420p"]
    if vfr:
        cmd += ["-fps_mode", "passthrough"]
    if start_time:
        cmd += ["-output_ts_offset", str(start_time)]
    cmd += ["-t", str(duration), str(out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace"))
    return out


@pytest.fixture(scope="session")
def profile():
    from apexhl.profile import load_profile
    return load_profile(ICON_DIR)


@pytest.fixture(scope="session")
def detector(profile):
    from apexhl.detect import Detector
    return Detector(profile)


def load_fixture(name, lang="zh-TW"):
    """讀取 fixtures/<lang> 下的 PNG（banner 在上、spec 在下垂直拼接）→ (banner, spec)。"""
    import cv2
    p = _profile()
    img = None
    for sub in ("pos", "neg"):
        f = FIXTURES / lang / sub / name
        if f.exists():
            img = cv2.imdecode(np.fromfile(str(f), dtype=np.uint8), cv2.IMREAD_COLOR)
    assert img is not None, name
    bh = p.banner_roi[3]
    sw, sh = p.spec_roi[2], p.spec_roi[3]
    return img[:bh], img[bh:bh + sh, :sw]


@functools.lru_cache(maxsize=None)
def _profile():
    from apexhl.profile import load_profile
    return load_profile(ICON_DIR)


@functools.lru_cache(maxsize=None)
def lang_labels(lang):
    return json.loads((FIXTURES / lang / "labels.json").read_text(encoding="utf-8"))


@pytest.fixture
def knock_banner_png(tmp_path):
    """把正例擊倒 fixture 裁成上方 180 列（只有 banner，供 make_video overlay 使用）。"""
    import cv2
    src = FIXTURES / "en" / "pos" / "knock_a002500.png"
    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_COLOR)
    out = tmp_path / "knock_banner.png"
    ok, buf = cv2.imencode(".png", img[:180])
    assert ok
    buf.tofile(str(out))
    return out
