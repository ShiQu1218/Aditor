import pytest

from aditor import ffbin


def test_ffbin_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("ADITOR_FFMPEG", str(tmp_path / "nope.exe"))
    with pytest.raises(FileNotFoundError):
        ffbin.ffmpeg()


def test_ffbin_missing(monkeypatch, tmp_path):
    monkeypatch.delenv("ADITOR_FFPROBE", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(ffbin, "BUNDLED_DIR", tmp_path / "no_ffmpeg_dir")
    with pytest.raises(FileNotFoundError, match="ffprobe not found"):
        ffbin.ffprobe()
