import json
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine_cli


def test_json_lines_uses_override_and_propagates_child_failure(monkeypatch):
    monkeypatch.setenv("ADITOR_ENGINE", sys.executable)
    assert list(engine_cli.json_lines("-c", 'print(\'{"t": 0.25}\')')) == [{"t": 0.25}]
    with pytest.raises(subprocess.CalledProcessError) as error:
        list(engine_cli.json_lines("-c", "raise SystemExit(7)"))
    assert error.value.returncode == 7


def test_analyze_reads_out_document_and_checks_exit_status(monkeypatch, tmp_path):
    out = tmp_path / "analysis.json"
    def run(args, *, check):
        assert check
        assert args[1:] == ["analyze", "video.mp4", "--profile-dir", "icons",
                            "--cache-dir", "cache", "--out", str(out), "--jobs", "4", "--force"]
        out.write_text(json.dumps({"events": []}), encoding="utf-8")
    monkeypatch.setattr(engine_cli.subprocess, "run", run)
    assert engine_cli.analyze("video.mp4", "icons", "cache", out, jobs=4) == {"events": []}


def test_ffmpeg_acceptance_uses_native_decode_only_path(monkeypatch):
    import runpy
    decode = runpy.run_path(str(engine_cli.ROOT / "ffmpeg-build/acceptance.py"))["decode"]
    calls = []
    def lines(*args):
        calls.append(args)
        yield {"frames": 8, "used_hwaccel": False}
    monkeypatch.setitem(decode.__globals__, "json_lines", lines)
    assert decode("video.mp4", False)["frames"] == 8
    assert calls[0] == ("debug-benchmark", "video.mp4", "--profile-dir",
                        engine_cli.ROOT / "templates/icons", "--decode-only", "--no-hwaccel")
