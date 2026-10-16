"""黃金短片（舊版遊戲 2026-07 錄影的 226 秒片段，不進 git）：以 APEXHL_GOLDEN_VIDEO 指定才執行。

expected.json 是人工逐一目視核對的事件（文字法時代建立，含 elim／squad_wipe）。產品範圍現在只有
knock 與助攻，所以只比對 expected 中的 knock／assist_*：每一筆都必須被找到（類型相同、時間 ±0.5 秒）。
圖示法在這支舊版錄影上有已知的額外事件（舊版「敵方小隊已消滅」「小隊抹殺」用單人加分圖示，見準確度報告），
列在 KNOWN_EXTRA；出現清單以外的額外事件會失敗。"""
import json
import os
from pathlib import Path

import pytest

EXPECTED = Path(__file__).parent / "golden" / "expected.json"
PRODUCT = {"knock", "assist_knock", "assist_elim"}
# 舊版遊戲橫幅的已知誤報（t 為事件第一次出現，±0.5 秒）：39.0／98.25／166.5 敵方小隊已消滅，138.5 小隊抹殺
KNOWN_EXTRA = [39.0, 98.25, 138.5, 166.5]


@pytest.mark.parametrize("jobs", [1, None], ids=["jobs1", "auto"])
def test_golden(tmp_path, profile, jobs):
    video = os.environ.get("APEXHL_GOLDEN_VIDEO")
    if not video or not Path(video).exists():
        pytest.skip("未設定 APEXHL_GOLDEN_VIDEO")
    from apexhl.analyze import analyze
    doc = analyze(video, profile, cache_dir=tmp_path, jobs=jobs)
    got = [(e["type"], e["t"]) for e in doc["events"]]
    assert {t for t, _ in got} <= PRODUCT
    exp = [e for e in json.loads(EXPECTED.read_text(encoding="utf-8"))["events"] if e["type"] in PRODUCT]
    left = list(got)
    for e in exp:
        hit = next((g for g in left if g[0] == e["type"] and abs(g[1] - e["t"]) <= 0.5), None)
        assert hit is not None, (e, got)
        left.remove(hit)
    extra = [t for _, t in left]
    assert len(extra) == len(KNOWN_EXTRA) and all(abs(a - b) <= 0.5 for a, b in zip(sorted(extra), KNOWN_EXTRA)), extra
