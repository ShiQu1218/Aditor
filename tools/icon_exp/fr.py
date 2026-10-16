"""共用：讀取 dump 的橫幅畫格、拼圖檢視。"""
import json, sys
from pathlib import Path
import numpy as np
import cv2

import os
# 工作資料夾（畫格 dump、特徵、接觸表；動輒數 GB，不可放在 repo 內）：環境變數 ICON_EXP_DIR，預設為本檔所在資料夾
SP = Path(os.environ.get("ICON_EXP_DIR", Path(__file__).resolve().parent))
TOOLS = Path(__file__).resolve().parent
FR = SP / "frames"
ENGINE = str(Path(__file__).resolve().parents[2] / "engine")
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)


def load(lab):
    meta = json.loads((FR / f"{lab}.json").read_text())
    return np.memmap(FR / f"{lab}.u8", dtype=np.uint8, mode="r", shape=(meta["n"], 180, 800, 3))


def idx(t):
    return int(round(t * 4))


def sheet(imgs, labels, out, cols=2, scale=1.0, rows=(30, 150)):
    """把多張橫幅（裁 rows 列）拼成一張圖，左上角標字。"""
    tiles = []
    for im, lb in zip(imgs, labels):
        im = np.ascontiguousarray(im[rows[0]:rows[1]])
        if scale != 1.0:
            im = cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        im = im.copy()
        cv2.putText(im, str(lb), (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
        tiles.append(im)
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    rws = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
    cv2.imwrite(str(out), np.vstack(rws))
