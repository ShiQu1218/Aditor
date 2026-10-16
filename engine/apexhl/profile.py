from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


class ProfileError(Exception):
    pass


@dataclass(frozen=True)
class KeywordSpec:
    file: str
    threshold: float


@dataclass
class Profile:
    lang: str
    templates_version: str
    banner_roi: tuple[int, int, int, int]
    spec_roi: tuple[int, int, int, int]
    white: dict
    red: dict
    keywords: dict[str, KeywordSpec]
    spec_templates: list[KeywordSpec]
    name_sig_threshold: float
    dedupe_window: float
    line1_rows: tuple[int, int] = (50, 108)  # 第一行關鍵字在 banner 內的垂直搜尋帶 [y0, y1)
    damage_depth: int = 40  # 傷害行搜尋：第一行下緣往下多少列
    dir: Path = field(default_factory=Path)


_REQUIRED = ["lang", "templates_version", "banner_roi", "spec_roi", "white", "red",
             "keywords", "spec_templates", "name_sig_threshold", "dedupe_window"]


def load_profile(dir: Path) -> Profile:
    dir = Path(dir)
    pj = dir / "profile.json"
    if not pj.exists():
        raise ProfileError(f"profile.json 不存在：{pj}")
    try:
        doc = json.loads(pj.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ProfileError(f"profile.json 格式錯誤：{e}") from e
    for k in _REQUIRED:
        if k not in doc:
            raise ProfileError(f"profile.json 缺少欄位：{k}")
    try:
        keywords = {k: KeywordSpec(v["file"], float(v["threshold"])) for k, v in doc["keywords"].items()}
        specs = [KeywordSpec(v["file"], float(v["threshold"])) for v in doc["spec_templates"]]
        p = Profile(
            lang=doc["lang"], templates_version=doc["templates_version"],
            banner_roi=tuple(int(x) for x in doc["banner_roi"]),
            spec_roi=tuple(int(x) for x in doc["spec_roi"]),
            white=doc["white"], red=doc["red"], keywords=keywords, spec_templates=specs,
            name_sig_threshold=float(doc["name_sig_threshold"]),
            dedupe_window=float(doc["dedupe_window"]),
            line1_rows=tuple(int(x) for x in doc.get("line1_rows", (50, 108))),
            damage_depth=int(doc.get("damage_depth", 40)), dir=dir)
    except (KeyError, TypeError, ValueError) as e:
        raise ProfileError(f"profile.json 欄位內容錯誤：{e!r}") from e
    for spec in [*keywords.values(), *specs]:
        if not (dir / spec.file).exists():
            raise ProfileError(f"範本檔遺失：{spec.file}")
    return p


LANG_ORDER = ("zh-TW", "en", "ja")


def resolve_profiles(dir: Path) -> list[Profile]:
    """載入單一語言設定檔，或自動偵測模式（auto / templates 根目錄）下載入所有語言設定檔。"""
    dir = Path(dir)
    if (dir / "profile.json").exists():
        return [load_profile(dir)]
    root = dir.parent if dir.name == "auto" else dir
    if root.is_dir():
        subs: list[Profile] = []
        seen: set[str] = set()
        for lang in LANG_ORDER:
            sub = root / lang
            if (sub / "profile.json").exists():
                subs.append(load_profile(sub))
                seen.add(lang)
        for sub in sorted(root.iterdir()):
            if sub.is_dir() and sub.name not in seen and (sub / "profile.json").exists():
                subs.append(load_profile(sub))
        if subs:
            return subs
    raise ProfileError(f"profile.json 不存在：{dir / 'profile.json'}")

