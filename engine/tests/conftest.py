"""Shared test utilities: synthetic video generator and fixture paths."""
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
LANGS = ("zh-TW", "en", "ja")  # Fixture source languages (asset categories only; the engine is language-independent).


def _ffmpeg() -> str:
    from aditor import ffbin
    return ffbin.ffmpeg()


def make_video(tmp_path, name, duration, *, start_time=0.0, vfr=False, marks=(), overlay=None, game_height=1080,
               game_aspect=None):
    """Use ffmpeg testsrc2 to create a 1920x1080, 60 fps H.264 video with -g 60.

    game_height: render the scene on a 1920×game_height canvas (1440 = a 4:3 game) with the banner and marks kept at the
    center-anchored HUD position, then stretch it to 1920×1080 as a full-screen 4:3 game does.

    marks: (t_start, t_end) pairs; draw a solid white rectangle in the banner region during these intervals.
    start_time: implemented with -output_ts_offset. vfr: drop frames and jitter PTS to create variable frame rate.
    overlay: (png_path, [(t_start, t_end), ...]); overlay the PNG at (560, 700).
    """
    out = Path(tmp_path) / name
    shift = (game_height - 1080) // 2
    filters = []
    for a, b in marks:
        filters.append(f"drawbox=x=400:y={600 + shift}:w=1120:h=350:color=white:t=fill:enable='between(t,{a},{b})'")
    inputs = ["-f", "lavfi", "-i", f"testsrc2=size=1920x{game_height}:rate=60:duration={duration}"]
    chain = ",".join(filters) if filters else "null"
    if vfr:
        chain += ",select='not(eq(mod(n,7),3))',setpts='PTS+(0.006*sin(N*7))/TB'"
    fc = f"[0:v]{chain}[v0]"
    last = "[v0]"
    if overlay:
        png, spans = overlay
        inputs += ["-loop", "1", "-i", str(png)]
        en = "+".join(f"between(t,{a},{b})" for a, b in spans)
        fc += f";[v0][1:v]overlay=x=560:y={700 + shift}:enable='{en}':shortest=1[v1]"
        last = "[v1]"
    if game_height != 1080:
        fc += f";{last}scale=1920:1080[vs]"
        last = "[vs]"
    cmd = [_ffmpeg(), "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", last,
           "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-pix_fmt", "yuv420p"]
    if vfr:
        cmd += ["-fps_mode", "passthrough"]
    if start_time:
        cmd += ["-output_ts_offset", str(start_time)]
    if game_aspect is not None:
        cmd += ["-metadata", f"aditor_game_aspect={game_aspect}", "-movflags", "+use_metadata_tags"]
    cmd += ["-t", str(duration), str(out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace"))
    return out


@pytest.fixture(scope="session")
def profile():
    from aditor.profile import load_profile
    return load_profile(ICON_DIR)


@pytest.fixture(scope="session")
def detector(profile):
    from aditor.detect import Detector
    return Detector(profile)


def load_fixture(name, lang="zh-TW"):
    """Read a PNG under fixtures/<lang> (banner on top, spec below) and return (banner, spec)."""
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
    from aditor.profile import load_profile
    return load_profile(ICON_DIR)


@functools.lru_cache(maxsize=None)
def lang_labels(lang):
    return json.loads((FIXTURES / lang / "labels.json").read_text(encoding="utf-8"))


@pytest.fixture
def knock_banner_png(tmp_path):
    """Crop the top 180 rows from a positive knock fixture (banner only) for make_video overlays."""
    import cv2
    src = FIXTURES / "en" / "pos" / "knock_a002500.png"
    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_COLOR)
    out = tmp_path / "knock_banner.png"
    ok, buf = cv2.imencode(".png", img[:180])
    assert ok
    buf.tofile(str(out))
    return out
