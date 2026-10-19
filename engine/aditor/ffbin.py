import os
import shutil
from pathlib import Path


def _find(env_var: str, exe: str, required_name: str) -> str:
    """解析順序：環境變數 → ADITOR_FFMPEG 同目錄 → 引擎旁的 ffmpeg/ 目錄 → PATH。"""
    env = os.environ.get(env_var)
    if env:
        if Path(env).exists():
            return env
        raise FileNotFoundError(f"{required_name} not found: {env_var}={env}")
    ffmpeg_env = os.environ.get("ADITOR_FFMPEG")
    if ffmpeg_env:
        sibling = Path(ffmpeg_env).parent / (exe + (".exe" if os.name == "nt" else ""))
        if sibling.exists():
            return str(sibling)
    for d in (BUNDLED_DIR, BUNDLED_DIR / "bin"):
        cand = d / (exe + (".exe" if os.name == "nt" else ""))
        if cand.exists():
            return str(cand)
    found = shutil.which(exe)
    if found:
        return found
    raise FileNotFoundError(f"{required_name} not found (set {env_var}, place in ffmpeg/ or add to PATH)")


BUNDLED_DIR = Path(__file__).resolve().parent.parent / "ffmpeg"


def ffmpeg() -> str:
    return _find("ADITOR_FFMPEG", "ffmpeg", "ffmpeg")


def ffprobe() -> str:
    return _find("ADITOR_FFPROBE", "ffprobe", "ffprobe")
