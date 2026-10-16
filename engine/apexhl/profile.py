"""偵測設定檔（templates/icons/profile.json）：與語言無關，單一設定檔。

事件偵測只靠圖示樣板（icon_detect）與敵人名字色規則；唯一與語言有關的樣板是觀戰提示條
（`spectating`，多語言並列，任一命中即算觀戰）。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


class ProfileError(Exception):
    pass


@dataclass(frozen=True)
class SpecTemplate:
    """觀戰提示條樣板：檔名、門檻與該樣板自己的白字遮罩門檻（各語言錄影的字亮度不同）。"""
    file: str
    threshold: float
    white: dict


@dataclass
class Profile:
    templates_version: str
    banner_roi: tuple[int, int, int, int]
    spec_roi: tuple[int, int, int, int]
    white: dict            # 名字指紋的白字墨規則
    red: dict              # 敵人名字色規則（紅，含 yellow、pink 子規則）
    spectating: list[SpecTemplate]
    name_sig_threshold: float
    dedupe_window: float
    dir: Path = field(default_factory=Path)


_REQUIRED = ["templates_version", "banner_roi", "spec_roi", "white", "red", "spectating",
             "name_sig_threshold", "dedupe_window"]


def _err(msg: str) -> ProfileError:
    return ProfileError(f"profile.json {msg}")


def _num(v, field_name: str, lo: float | None = None, hi: float | None = None,
         lo_open: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _err(f"欄位 {field_name} 必須是數字：{v!r}")
    if lo is not None and (v <= lo if lo_open else v < lo):
        raise _err(f"欄位 {field_name} 超出範圍：{v!r}")
    if hi is not None and v > hi:
        raise _err(f"欄位 {field_name} 超出範圍：{v!r}")
    return float(v)


def _int_list(v, n: int, field_name: str, lo: int = 0) -> tuple[int, ...]:
    if not isinstance(v, (list, tuple)) or len(v) != n or any(
            isinstance(x, bool) or not isinstance(x, int) or x < lo for x in v):
        raise _err(f"欄位 {field_name} 必須是 {n} 個整數（≥{lo}）：{v!r}")
    return tuple(int(x) for x in v)


def _white(v, where: str) -> dict:
    if not isinstance(v, dict):
        raise _err(f"欄位 {where} 必須是物件")
    for k in ("v_min", "s_max"):
        _num(v.get(k), f"{where}.{k}", 0, 255)
    return v


def load_profile(dir: Path) -> Profile:
    dir = Path(dir)
    pj = dir / "profile.json"
    if not pj.exists():
        raise ProfileError(f"profile.json 不存在：{pj}")
    try:
        doc = json.loads(pj.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ProfileError(f"profile.json 格式錯誤：{e}") from e
    if not isinstance(doc, dict):
        raise ProfileError("profile.json 必須是 JSON 物件")
    for k in _REQUIRED:
        if k not in doc:
            raise ProfileError(f"profile.json 缺少欄位：{k}")
    if not isinstance(doc["templates_version"], str) or not doc["templates_version"]:
        raise _err("欄位 templates_version 必須是非空字串")
    banner_roi = _int_list(doc["banner_roi"], 4, "banner_roi")
    spec_roi = _int_list(doc["spec_roi"], 4, "spec_roi")
    if banner_roi[2] <= 0 or banner_roi[3] <= 0 or spec_roi[2] <= 0 or spec_roi[3] <= 0:
        raise _err("banner_roi／spec_roi 的寬高必須 > 0")
    white = _white(doc["white"], "white")
    if not isinstance(doc["red"], dict):
        raise _err("欄位 red 必須是物件")
    for k in ("r_min", "g_max", "b_max"):
        _num(doc["red"].get(k), f"red.{k}", 0, 255)
    if "r_diff_min" in doc["red"]:
        _num(doc["red"]["r_diff_min"], "red.r_diff_min", 0, 255)
    if not isinstance(doc["spectating"], list):
        raise _err("欄位 spectating 必須是陣列")
    specs: list[SpecTemplate] = []
    for i, v in enumerate(doc["spectating"]):
        if not isinstance(v, dict) or not isinstance(v.get("file"), str) or not v["file"]:
            raise _err(f"spectating[{i}] 必須有字串欄位 file")
        thr = _num(v.get("threshold"), f"spectating[{i}].threshold", 0.0, 1.0, lo_open=True)
        specs.append(SpecTemplate(v["file"], thr, _white(v.get("white", white), f"spectating[{i}].white")))
    p = Profile(
        templates_version=doc["templates_version"], banner_roi=banner_roi, spec_roi=spec_roi,  # type: ignore[arg-type]
        white=white, red=doc["red"], spectating=specs,
        name_sig_threshold=_num(doc["name_sig_threshold"], "name_sig_threshold", 0.0, 1.0, lo_open=True),
        dedupe_window=_num(doc["dedupe_window"], "dedupe_window", 0.0, lo_open=True), dir=dir)
    for spec in specs:
        if not (dir / spec.file).exists():
            raise ProfileError(f"範本檔遺失：{spec.file}")
    return p
