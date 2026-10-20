"""Golden video (a 226-second clip from a 2026-07 recording of the old game, not checked into git); runs only when ADITOR_GOLDEN_VIDEO is set.

expected.json contains events manually reviewed frame by frame (created during the text-based detector era, including elim/squad_wipe). The product now supports only
knock and assists, so compare only knock/assist_* entries in expected: every entry must be found with the same type and within ±0.5 seconds.
Icon detection has known extra events on this old recording (the old-game banners "敵方小隊已消滅" and "小隊抹殺" use the solo bonus icon; see the accuracy report).
They are listed in KNOWN_EXTRA; extra events must come from that list (per-video kill-keyword validation currently blocks all of them, so usually there are no extras).
Any extra event outside the list fails the test."""
import json
import os
from pathlib import Path

import pytest

EXPECTED = Path(__file__).parent / "golden" / "expected.json"
PRODUCT = {"knock", "assist_knock", "assist_elim"}
# Known false positives from old-game banners (t is the first event timestamp, ±0.5 seconds): 39.0/98.25/166.5 "敵方小隊已消滅", 138.5 "小隊抹殺".
KNOWN_EXTRA = [39.0, 98.25, 138.5, 166.5]


@pytest.mark.parametrize("jobs", [1, None], ids=["jobs1", "auto"])
def test_golden(tmp_path, profile, jobs):
    video = os.environ.get("ADITOR_GOLDEN_VIDEO")
    if not video or not Path(video).exists():
        pytest.skip("ADITOR_GOLDEN_VIDEO is not set")
    from aditor.analyze import analyze
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
    assert all(any(abs(a - b) <= 0.5 for b in KNOWN_EXTRA) for a in extra), extra
