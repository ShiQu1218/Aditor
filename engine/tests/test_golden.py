import json
import os
from pathlib import Path

import pytest

EXPECTED = Path(__file__).parent / "golden" / "expected.json"


def test_golden(tmp_path, zh_profile):
    video = os.environ.get("APEXHL_GOLDEN_VIDEO")
    if not video or not Path(video).exists():
        pytest.skip("未設定 APEXHL_GOLDEN_VIDEO")
    from apexhl.analyze import analyze
    doc = analyze(video, zh_profile, cache_dir=tmp_path)
    got = [(e["type"], e["t"]) for e in doc["events"]]
    exp = json.loads(EXPECTED.read_text(encoding="utf-8"))["events"]
    assert len(got) == len(exp), (got, exp)
    for (gt, gtime), e in zip(got, exp):
        assert gt == e["type"] and gtime == pytest.approx(e["t"], abs=0.5), (got, exp)
