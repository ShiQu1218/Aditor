"""Template extraction utility: dump (export normalized ROI frames), crop, and sheet (contact sheet).

Usage:
  python tools/extract_templates.py dump <video> --start S --end E [--fps 4] [--roi x,y,w,h] --out DIR
  python tools/extract_templates.py crop <png> --rect x,y,w,h --out FILE
  python tools/extract_templates.py sheet <dir> --out FILE [--cols 4]
"""
import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

def ffmpeg():
    override = os.environ.get("ADITOR_FFMPEG")
    if override:
        if not Path(override).is_file():
            raise FileNotFoundError(f"ADITOR_FFMPEG not found: {override}")
        return override
    bundled = Path(__file__).resolve().parents[1] / "build/ffmpeg/bin/ffmpeg.exe"
    found = str(bundled) if bundled.is_file() else shutil.which("ffmpeg")
    if not found:
        raise FileNotFoundError("ffmpeg not found; set ADITOR_FFMPEG or add it to PATH")
    return found


def imread(p):
    return cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)


def imwrite(p, img):
    ok, buf = cv2.imencode(Path(p).suffix or ".png", img)
    assert ok
    buf.tofile(str(p))


def parse_rect(s):
    x, y, w, h = (int(v) for v in s.split(","))
    return x, y, w, h


def dump(video, start, end, fps, roi, out, scale_to=None):
    """Save each frame as t{seconds:08.2f}.png; fps may be fractional (for example, 1, 0.5, or 4)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    vf = f"fps={fps},scale=1920:1080"
    if roi:
        x, y, w, h = roi
        vf += f",crop={w}:{h}:{x}:{y}"
    if scale_to:
        vf += f",scale={scale_to}"
    with tempfile.TemporaryDirectory(prefix="aditor_dump_", dir=out) as tmp:
        video_out = Path(tmp) / "frames.mkv"
        # The bundled FFmpeg has FFV1 but no PNG encoder; OpenCV writes the lossless frames as PNG.
        cmd = [ffmpeg(), "-v", "error", "-y", "-hwaccel", "auto", "-ss", str(start), "-to", str(end), "-i", str(video),
               "-vf", vf, "-an", "-c:v", "ffv1", "-threads", "2", "-pix_fmt", "bgr0", "-progress", "pipe:1", str(video_out)]
        result = subprocess.run(cmd, check=True, stdout=subprocess.PIPE)
        counts = [int(line[6:]) for line in result.stdout.splitlines() if line.startswith(b"frame=")]
        if counts and counts[-1] == 0:
            return 0
        capture = cv2.VideoCapture(str(video_out))
        try:
            if not capture.isOpened():
                raise RuntimeError("Could not open extracted frames")
            n = 0
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                png = Path(tmp) / "frame.png"
                imwrite(png, frame)
                os.replace(png, out / f"t{start + n / float(fps):08.2f}.png")
                n += 1
            return n
        finally:
            capture.release()



def crop(png, rect, out, mask=False, v_min=200, s_max=60):
    x, y, w, h = rect
    img = imread(png)[y:y + h, x:x + w]
    if mask:  # Export a binary white-text mask using the engine's white_mask definition for use as a template.
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        img = (((hsv[..., 2] >= v_min) & (hsv[..., 1] <= s_max)).astype(np.uint8) * 255)
    imwrite(out, img)


def sheet(d, out, cols=4, label=True):
    files = sorted(Path(d).glob("*.png"))
    imgs = []
    for f in files:
        im = imread(f)
        if label:
            im = im.copy()
            cv2.putText(im, f.stem, (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        imgs.append(im)
    if not imgs:
        raise SystemExit("No PNG files found")
    h = max(i.shape[0] for i in imgs)
    w = max(i.shape[1] for i in imgs)
    rows = (len(imgs) + cols - 1) // cols
    canvas = np.zeros((rows * h, cols * w, 3), np.uint8)
    for i, im in enumerate(imgs):
        r, c = divmod(i, cols)
        canvas[r * h:r * h + im.shape[0], c * w:c * w + im.shape[1]] = im
    imwrite(out, canvas)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dump")
    d.add_argument("video")
    d.add_argument("--start", type=float, default=0)
    d.add_argument("--end", type=float, required=True)
    d.add_argument("--fps", default="4")
    d.add_argument("--roi", default=None)
    d.add_argument("--scale", default=None, help="Additional scaling, such as 480:270 (for visual inspection only)")
    d.add_argument("--out", required=True)
    c = sub.add_parser("crop")
    c.add_argument("png")
    c.add_argument("--rect", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--mask", action="store_true", help="Export a binary white-text mask for use as a template")
    s = sub.add_parser("sheet")
    s.add_argument("dir")
    s.add_argument("--out", required=True)
    s.add_argument("--cols", type=int, default=4)
    a = ap.parse_args()
    if a.cmd == "dump":
        n = dump(a.video, a.start, a.end, a.fps, parse_rect(a.roi) if a.roi else None, a.out, a.scale)
        print(f"dumped {n} frames")
    elif a.cmd == "crop":
        crop(a.png, parse_rect(a.rect), a.out, a.mask)
    else:
        sheet(a.dir, a.out, a.cols)


if __name__ == "__main__":
    main()

