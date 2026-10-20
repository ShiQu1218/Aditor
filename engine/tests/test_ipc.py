import json
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from conftest import ICON_DIR, make_video

ENGINE = Path(__file__).resolve().parents[1]


class Proc:
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, "-m", "aditor", "ipc"], cwd=ENGINE,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.q: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.q.put(json.loads(line.decode("utf-8")))
        self.q.put(None)

    def send(self, obj):
        self.send_raw((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))

    def send_raw(self, b):
        self.p.stdin.write(b)
        self.p.stdin.flush()

    def get(self, timeout=60):
        m = self.q.get(timeout=timeout)
        assert m is not None, self.p.stderr.read().decode(errors="replace")
        return m

    def until(self, pred, timeout=120):
        while True:
            m = self.get(timeout)
            if pred(m):
                return m

    def close(self):
        self.p.stdin.close()
        rc = self.p.wait(timeout=60)
        self.p.stderr.close()
        self.p.stdout.close()
        return rc


def test_ipc_ready_probe_and_error(tmp_path):
    p = Proc()
    ready = p.get()
    assert ready["type"] == "ready" and ready["engine_version"] == "0.3.0"
    v = make_video(tmp_path, "含 空白.mp4", 2)
    p.send({"id": "1", "cmd": "probe", "args": {"path": str(v)}})
    r = p.get()
    assert r["id"] == "1" and r["type"] == "result" and r["data"]["width"] == 1920
    p.send_raw(b"not json\n")
    e = p.get()
    assert e["type"] == "error" and e["code"] == "bad_request"
    p.send({"id": "2", "cmd": "nope", "args": {}})
    assert p.get()["code"] == "bad_request"
    p.send({"id": "3", "cmd": "probe", "args": {}})
    assert p.get()["code"] == "bad_request"
    p.send({"id": "4", "cmd": "probe", "args": {"path": str(tmp_path / "missing.mp4")}})
    e = p.get()
    assert e["id"] == "4" and e["code"] == "probe_failed"
    p.send({"id": "5", "cmd": "analyze", "args": {"path": str(v), "profile_dir": str(tmp_path),
                                                  "cache_dir": str(tmp_path)}})
    assert p.get()["code"] == "profile_error"
    assert p.close() == 0


def test_ipc_busy_and_cancel(tmp_path, knock_banner_png):
    v = make_video(tmp_path, "long.mp4", 240, overlay=(knock_banner_png, [(120.0, 130.0)]))
    p = Proc()
    p.get()
    args = {"path": str(v), "profile_dir": str(ICON_DIR), "cache_dir": str(tmp_path / "c")}
    p.send({"id": "a", "cmd": "analyze", "args": args})
    p.send({"id": "b", "cmd": "analyze", "args": args})
    busy = p.until(lambda m: m.get("id") == "b")
    assert busy["type"] == "error" and busy["code"] == "busy"
    prog = p.until(lambda m: m.get("id") == "a" and m["type"] == "progress")
    assert prog["duration"] == pytest.approx(240, abs=1)
    p.send({"id": "c", "cmd": "cancel", "args": {"target": "a"}})
    end = p.until(lambda m: m.get("id") == "a" and m["type"] in ("error", "result"))
    assert end["type"] == "error" and end["code"] == "cancelled"
    assert p.close() == 0


def test_ipc_analyze_result(tmp_path):
    v = make_video(tmp_path, "s.mp4", 4)
    p = Proc()
    p.get()
    p.send({"id": "a", "cmd": "analyze", "args": {"path": str(v), "profile_dir": str(ICON_DIR),
                                                   "cache_dir": str(tmp_path / "c")}})
    end = p.until(lambda m: m.get("id") == "a" and m["type"] in ("error", "result"))
    assert end["type"] == "result" and end["data"]["analysis"]["status"] == "done"
    assert Path(end["data"]["cache_path"]).exists()
    assert p.close() == 0


def test_ipc_autoclip_roundtrip():
    p = Proc()
    p.get()
    ev = [{"id": f"e{i}", "t": 100.0 + 5 * i, "type": "knock", "score": 0.9, "damage_line": True,
           "name_sig": None, "counted": True, "counted_reason": "first"} for i in range(3)]
    p.send({"id": "x", "cmd": "autoclip", "args": {"events": ev, "params": {}, "duration": 600.0}})
    r = p.get()
    assert r["type"] == "result"
    clips = r["data"]["clips"]
    assert len(clips) == 1 and clips[0]["start"] == 92.0 and clips[0]["end"] == 114.0
    assert clips[0]["event_ids"] == ["e0", "e1", "e2"]
    p.send({"id": "y", "cmd": "derive", "args": {"events": ev, "spectating": [{"start": 99, "end": 106}],
                                                 "profile_dir": str(ICON_DIR)}})
    d = p.get()["data"]["events"]
    assert [e["counted_reason"] for e in d] == ["spectating", "spectating", "first"]
    assert p.close() == 0


def test_ipc_no_false_busy_after_terminal_line(tmp_path):
    v = make_video(tmp_path, "s.mp4", 3)
    p = Proc()
    p.get()
    args = {"path": str(v), "profile_dir": str(ICON_DIR), "cache_dir": str(tmp_path / "c"), "force": True}
    for i in range(3):
        rid = f"a{i}"
        p.send({"id": rid, "cmd": "analyze", "args": args})
        end = p.until(lambda m: m.get("id") == rid and m["type"] in ("error", "result"))
        assert end["type"] == "result", end  # A resend immediately after the terminal message must not be busy.
    assert p.close() == 0


def test_server_prunes_finished_worker_threads():
    """Long-lived IPC sessions do not keep completed worker threads in _threads."""
    import io
    from aditor.ipc import Server
    srv = Server(io.BytesIO(), io.BytesIO())
    req = json.dumps({"id": "x", "cmd": "autoclip",
                      "args": {"events": [], "params": {}, "duration": 1}})
    for _ in range(20):
        srv._dispatch(req)
        for t in list(srv._threads):
            t.join(timeout=10)
    srv._dispatch(req)
    assert len(srv._threads) <= 2


def test_ipc_analyze_game_aspect(tmp_path):
    v = make_video(tmp_path, "s.mp4", 2, game_aspect="1920x1440")
    p = Proc()
    p.get()
    base = {"path": str(v), "profile_dir": str(ICON_DIR), "cache_dir": str(tmp_path / "c")}
    p.send({"id": "tag", "cmd": "analyze", "args": base})
    end = p.until(lambda m: m.get("id") == "tag" and m["type"] in ("error", "result"))
    assert end["type"] == "result" and end["data"]["analysis"]["aspect_squash"] == 0.75
    p.send({"id": "override", "cmd": "analyze", "args": {**base, "aspect": "16:9"}})
    end = p.until(lambda m: m.get("id") == "override" and m["type"] in ("error", "result"))
    assert end["type"] == "result" and end["data"]["analysis"]["aspect_squash"] == 1.0
    p.send({"id": "a", "cmd": "analyze", "args": {**base, "aspect": "1920x1440"}})
    end = p.until(lambda m: m.get("id") == "a" and m["type"] in ("error", "result"))
    assert end["type"] == "result" and end["data"]["analysis"]["aspect_squash"] == 0.75
    p.send({"id": "b", "cmd": "analyze", "args": {**base, "aspect": "21:9"}})
    end = p.until(lambda m: m.get("id") == "b" and m["type"] in ("error", "result"))
    assert end["type"] == "error" and end["code"] == "bad_request"
    assert p.close() == 0
