"""Detection profile (templates/icons/profile.json): shared icon/color settings.

BR detection uses language-independent icons and enemy-name colors. Spectator banners (`spectating`) cover multiple languages;
the additional text-only Mixtape keyword templates cover Traditional Chinese and English."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

from .icon_detect import ICON_NAMES
from .layout import BANNER_ANCHOR, SPEC_ANCHOR, Layout, capture_rect


class ProfileError(Exception):
    pass


@dataclass(frozen=True)
class SpecTemplate:
    """Spectator banner template: filename, match threshold, and its own white-text mask threshold (text brightness varies by recording language)."""
    file: str
    threshold: float
    white: dict


@dataclass
class Profile:
    templates_version: str
    banner_roi: tuple[int, int, int, int]
    spec_roi: tuple[int, int, int, int]
    white: dict            # White-ink rules for name fingerprints
    red: dict              # Enemy-name color rules (red, including yellow and pink subrules)
    spectating: list[SpecTemplate]
    name_sig_threshold: float
    dedupe_window: float
    dir: Path = field(default_factory=Path)
    layout: Layout = Layout(1.0)  # Game render aspect; banner_roi/spec_roi stay in 16:9 reference layout.
    killfeed_roi: tuple[int, int, int, int] | None = None

    @property
    def capture_killfeed(self):
        return capture_rect(self.killfeed_roi, "top") if self.killfeed_roi is not None else None

    def restore_killfeed(self, image):
        return self.layout.extract(image, self.capture_killfeed, self.killfeed_roi, "top")

    @property
    def capture_banner(self) -> tuple[int, int, int, int]:
        """Region cropped from the 1920×1080-normalized frame; contains banner_roi's content at every supported aspect."""
        return capture_rect(self.banner_roi, BANNER_ANCHOR)

    @property
    def capture_spec(self) -> tuple[int, int, int, int]:
        return capture_rect(self.spec_roi, SPEC_ANCHOR)

    def with_layout(self, layout: Layout) -> "Profile":
        return replace(self, layout=layout)

    def restore(self, banner_capture, spec_capture):
        """Convert captured regions (capture_banner/capture_spec) into reference-layout banner and spec images."""
        return (self.layout.extract(banner_capture, self.capture_banner, self.banner_roi, BANNER_ANCHOR),
                self.layout.extract(spec_capture, self.capture_spec, self.spec_roi, SPEC_ANCHOR))


# Optional red subrules for colorblind name colors and their required fields; detect.red_mask reads these keys directly.
_RED_SUBRULES = {
    "yellow": ("r_min", "g_min", "b_max", "rb_min", "rg_max"),
    "pink": ("r_min", "g_min", "rg_min", "bg_min", "rb_min"),
}

_REQUIRED = ["templates_version", "banner_roi", "spec_roi", "white", "red", "spectating",
             "name_sig_threshold", "dedupe_window"]


def _err(msg: str) -> ProfileError:
    return ProfileError(f"profile.json {msg}")


def _num(v, field_name: str, lo: float | None = None, hi: float | None = None,
         lo_open: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _err(f"Field {field_name} must be a number: {v!r}")
    if lo is not None and (v <= lo if lo_open else v < lo):
        raise _err(f"Field {field_name} is out of range: {v!r}")
    if hi is not None and v > hi:
        raise _err(f"Field {field_name} is out of range: {v!r}")
    return float(v)


def _int_list(v, n: int, field_name: str, lo: int = 0) -> tuple[int, ...]:
    if not isinstance(v, (list, tuple)) or len(v) != n or any(
            isinstance(x, bool) or not isinstance(x, int) or x < lo for x in v):
        raise _err(f"Field {field_name} must contain {n} integers (≥{lo}): {v!r}")
    return tuple(int(x) for x in v)


def _white(v, where: str) -> dict:
    if not isinstance(v, dict):
        raise _err(f"Field {where} must be an object")
    for k in ("v_min", "s_max"):
        _num(v.get(k), f"{where}.{k}", 0, 255)
    return v


def load_profile(dir: Path) -> Profile:
    dir = Path(dir)
    pj = dir / "profile.json"
    if not pj.exists():
        raise ProfileError(f"profile.json does not exist: {pj}")
    try:
        doc = json.loads(pj.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ProfileError(f"Invalid profile.json: {e}") from e
    if not isinstance(doc, dict):
        raise ProfileError("profile.json must be a JSON object")
    for k in _REQUIRED:
        if k not in doc:
            raise ProfileError(f"Missing field in profile.json: {k}")
    if not isinstance(doc["templates_version"], str) or not doc["templates_version"]:
        raise _err("Field templates_version must be a non-empty string")
    banner_roi = _int_list(doc["banner_roi"], 4, "banner_roi")
    spec_roi = _int_list(doc["spec_roi"], 4, "spec_roi")
    killfeed_roi = _int_list(doc["killfeed_roi"], 4, "killfeed_roi") if "killfeed_roi" in doc else None
    if killfeed_roi is not None:
        x, y, w, h = killfeed_roi
        if w <= 0 or h <= 0 or x + w > 1920 or y + h > 1080:
            raise _err("killfeed_roi must fit within 1920×1080 and have positive dimensions")
    if banner_roi[2] <= 0 or banner_roi[3] <= 0 or spec_roi[2] <= 0 or spec_roi[3] <= 0:
        raise _err("banner_roi/spec_roi width and height must be > 0")
    white = _white(doc["white"], "white")
    if not isinstance(doc["red"], dict):
        raise _err("Field red must be an object")
    for k in ("r_min", "g_max", "b_max"):
        _num(doc["red"].get(k), f"red.{k}", 0, 255)
    if "r_diff_min" in doc["red"]:
        _num(doc["red"]["r_diff_min"], "red.r_diff_min", 0, 255)
    for sub, keys in _RED_SUBRULES.items():
        if sub not in doc["red"]:
            continue
        rule = doc["red"][sub]
        if not isinstance(rule, dict):
            raise _err(f"Field red.{sub} must be an object")
        for k in keys:
            _num(rule.get(k), f"red.{sub}.{k}", -255, 255)
    if not isinstance(doc["spectating"], list):
        raise _err("Field spectating must be an array")
    specs: list[SpecTemplate] = []
    for i, v in enumerate(doc["spectating"]):
        if not isinstance(v, dict) or not isinstance(v.get("file"), str) or not v["file"]:
            raise _err(f"spectating[{i}] must have a string field named file")
        if Path(v["file"]).name != v["file"] or v["file"] in (".", ".."):
            raise _err(f"spectating[{i}].file must be a filename in the profile directory (no path allowed): {v['file']!r}")
        thr = _num(v.get("threshold"), f"spectating[{i}].threshold", 0.0, 1.0, lo_open=True)
        specs.append(SpecTemplate(v["file"], thr, _white(v.get("white", white), f"spectating[{i}].white")))
    p = Profile(
        templates_version=doc["templates_version"], banner_roi=banner_roi, spec_roi=spec_roi,  # type: ignore[arg-type]
        white=white, red=doc["red"], spectating=specs,
        name_sig_threshold=_num(doc["name_sig_threshold"], "name_sig_threshold", 0.0, 1.0, lo_open=True),
        dedupe_window=_num(doc["dedupe_window"], "dedupe_window", 0.0, lo_open=True), dir=dir,
        killfeed_roi=killfeed_roi)
    for spec in specs:
        if not (dir / spec.file).exists():
            raise ProfileError(f"Template file is missing: {spec.file}")
    for name in ICON_NAMES:
        if not (dir / f"{name}.png").exists():
            raise ProfileError(f"Template file is missing: {name}.png")
    return p
