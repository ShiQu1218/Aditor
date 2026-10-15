import json
from pathlib import Path

from apexhl import ENGINE_VERSION, cache
from apexhl.models import Clip, Event, VideoInfo


def ev(id, t, type="knock", source="auto", deleted=False, override=None):
    return Event(id=id, t=t, type=type, score=0.9, damage_line=True, name_sig=None,
                 source=source, deleted=deleted, counted_override=override)


def info(size=10, mtime=100.0):
    return VideoInfo(path="x.mp4", duration=1.0, width=1920, height=1080, codec="av1",
                     start_time=0.0, size=size, mtime=mtime)


def good_doc():
    return {"analysis": {"status": "done", "engine_version": ENGINE_VERSION,
                         "templates_version": "zh-TW@1"},
            "video": {"size": 10, "mtime": 100.0}}


def test_cache_key_path_only(tmp_path):
    d = tmp_path / "cache"
    a = cache.cache_path(r"D:\Videos\A.mp4", d)
    b = cache.cache_path("d:/videos/a.MP4", d)
    assert a == b and a.parent == d and a.suffix == ".json"
    f = tmp_path / "v.mp4"
    f.write_bytes(b"1")
    k1 = cache.cache_path(str(f), d)
    f.write_bytes(b"22222")
    assert cache.cache_path(str(f), d) == k1


def test_cache_beside_chinese_space(tmp_path):
    v = tmp_path / "Apex 影片" / "a b.mp4"
    p = cache.cache_path(str(v), tmp_path / "c", beside=True)
    assert p == v.parent / "a b.apexhl.json"


def test_atomic_save_and_load(tmp_path):
    p = tmp_path / "快取 資料" / "k.json"
    doc = {"version": 1, "events": [{"name": "中文"}]}
    out = cache.save_cache(p, doc)
    assert out == p and cache.load_cache(p) == doc
    assert not list(p.parent.glob("*.tmp"))
    assert "中文" in p.read_text(encoding="utf-8")


def test_corrupt_cache_returns_none(tmp_path):
    assert cache.load_cache(tmp_path / "none.json") is None
    p = tmp_path / "bad 壞.json"
    p.write_text("{not json", encoding="utf-8")
    assert cache.load_cache(p) is None


def test_readonly_dir_falls_back(tmp_path):
    afile = tmp_path / "afile"
    afile.write_text("x")
    target = afile / "sub" / "x.json"
    fb = tmp_path / "備援 dir"
    out = cache.save_cache(target, {"a": 1}, fallback_dir=fb)
    assert out == fb / "x.json" and cache.load_cache(out) == {"a": 1}
    try:
        cache.save_cache(target, {"a": 1})
    except OSError:
        pass
    else:
        raise AssertionError("expected OSError")


def test_needs_reanalysis_triggers():
    assert not cache.needs_reanalysis(good_doc(), info(), "zh-TW@1")
    assert cache.needs_reanalysis(None, info(), "zh-TW@1")
    assert cache.needs_reanalysis(good_doc(), info(size=11), "zh-TW@1")
    assert cache.needs_reanalysis(good_doc(), info(mtime=101.0), "zh-TW@1")
    assert cache.needs_reanalysis(good_doc(), info(), "zh-TW@2")
    d = good_doc(); d["analysis"]["engine_version"] = "0.0.0"
    assert cache.needs_reanalysis(d, info(), "zh-TW@1")
    d = good_doc(); d["analysis"]["status"] = "running"
    assert cache.needs_reanalysis(d, info(), "zh-TW@1")


def test_merge_keeps_manual_and_transfers_state():
    old = [ev("m1", 5.0, source="manual"),
           ev("o1", 10.0, deleted=True),
           ev("o2", 20.0, override=True),
           ev("o3", 30.0)]
    new = [ev("n1", 10.6), ev("n2", 20.9, type="knock"), ev("n3", 50.0)]
    merged, unmatched = cache.merge_reanalysis(old, new)
    assert unmatched == []
    assert [e.id for e in merged] == ["m1", "n1", "n2", "n3"]
    by = {e.id: e for e in merged}
    assert by["n1"].deleted is True and by["n2"].counted_override is True
    assert by["n3"].deleted is False and by["n3"].counted_override is None


def test_merge_reports_unmatched():
    old = [ev("o1", 10.0, deleted=True), ev("o2", 20.0, override=False, type="elim"),
           ev("o3", 30.0, override=True), ev("o4", 30.4, override=False)]
    new = [ev("n1", 12.0), ev("n2", 20.2, type="knock"), ev("n3", 30.2)]
    merged, unmatched = cache.merge_reanalysis(old, new)
    assert [e.id for e in unmatched] == ["o1", "o2", "o4"]
    by = {e.id: e for e in merged}
    assert by["n3"].counted_override is True and by["n1"].deleted is False


def test_merge_clips_keeps_manual():
    old = [Clip("c1", 50, 60, "ai"), Clip("c2", 10, 20, "manual")]
    new = [Clip("c3", 30, 40, "ai")]
    out = cache.merge_clips(old, new)
    assert [c.id for c in out] == ["c2", "c3"]
