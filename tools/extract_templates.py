"""範本擷取工具：dump（逐格輸出正規化 ROI）、crop（裁切）、sheet（總覽圖）。

用法：
  python tools/extract_templates.py dump <video> --start S --end E [--fps 4] [--roi x,y,w,h] --out DIR
  python tools/extract_templates.py crop <png> --rect x,y,w,h --out FILE
  python tools/extract_templates.py sheet <dir> --out FILE [--cols 4]
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from aditor import ffbin  # noqa: E402


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
    """逐格存成 t{秒數:08.2f}.png；fps 可為小數（如 1、0.5、4）。"""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    vf = f"fps={fps},scale=1920:1080"
    if roi:
        x, y, w, h = roi
        vf += f",crop={w}:{h}:{x}:{y}"
    if scale_to:
        vf += f",scale={scale_to}"
    tmp = out / "_tmp_%06d.png"
    cmd = [ffbin.ffmpeg(), "-v", "error", "-y", "-hwaccel", "auto", "-ss", str(start), "-to", str(end), "-i", str(video),
           "-vf", vf, "-start_number", "0", "-f", "image2", str(tmp)]
    subprocess.run(cmd, check=True)
    n = 0
    for f in sorted(out.glob("_tmp_*.png")):
        k = int(re.search(r"_tmp_(\d+)", f.name).group(1))
        t = start + k / float(fps)
        dst = out / f"t{t:08.2f}.png"
        if dst.exists():
            dst.unlink()
        os.replace(f, dst)
        n += 1
    return n


def crop(png, rect, out, mask=False, v_min=200, s_max=60):
    x, y, w, h = rect
    img = imread(png)[y:y + h, x:x + w]
    if mask:  # 輸出白字二值圖（與引擎 white_mask 相同定義），用來當範本
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
        raise SystemExit("沒有 PNG")
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
    d.add_argument("--scale", default=None, help="額外縮放，如 480:270（只給目視用）")
    d.add_argument("--out", required=True)
    c = sub.add_parser("crop")
    c.add_argument("png")
    c.add_argument("--rect", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--mask", action="store_true", help="輸出白字二值遮罩（範本用）")
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

