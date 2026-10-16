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
    # 「獨立擊殺」橫幅的名字位置：right＝在關鍵字右側（zh-TW、en）；left＝在關鍵字左側、
    # 骷髏圖示右側（ja：[骷髏] 名字 を撃破），需要 `skull` 範本。
    name_side: str = "right"
    # 助攻橫幅的名字夾在「助攻」與「擊倒／擊殺」關鍵字之間（ja：アシスト、名字をダウン）。
    name_between_assist: bool = False
    # False＝此語言沒有（真實素材來源的）觀戰範本，無法偵測觀戰；analysis 會標記給 App 警告。
    spectating_supported: bool = True
    dir: Path = field(default_factory=Path)

    @property
    def veto_supported(self) -> bool:
        return "enemy_squad_down" in self.keywords


REQUIRED_KEYWORDS = ("squad_wipe", "assist", "knock", "damage", "elim", "elim_done")
OPTIONAL_KEYWORDS = ("enemy_squad_down", "assist_knock", "skull")
_REQUIRED = ["lang", "templates_version", "banner_roi", "spec_roi", "white", "red",
             "keywords", "spec_templates", "name_sig_threshold", "dedupe_window"]
NAME_SIDES = ("right", "left")


def _err(where: str, msg: str) -> ProfileError:
    return ProfileError(f"profile.json（{where}）{msg}")


def _num(v, where: str, field_name: str, lo: float | None = None, hi: float | None = None,
         lo_open: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _err(where, f"欄位 {field_name} 必須是數字：{v!r}")
    if lo is not None and (v <= lo if lo_open else v < lo):
        raise _err(where, f"欄位 {field_name} 超出範圍：{v!r}")
    if hi is not None and v > hi:
        raise _err(where, f"欄位 {field_name} 超出範圍：{v!r}")
    return float(v)


def _int_list(v, n: int, where: str, field_name: str, lo: int = 0) -> tuple[int, ...]:
    if not isinstance(v, (list, tuple)) or len(v) != n or any(
            isinstance(x, bool) or not isinstance(x, int) or x < lo for x in v):
        raise _err(where, f"欄位 {field_name} 必須是 {n} 個整數（≥{lo}）：{v!r}")
    return tuple(int(x) for x in v)


def _kw(v, where: str, field_name: str) -> KeywordSpec:
    if not isinstance(v, dict) or not isinstance(v.get("file"), str) or not v["file"]:
        raise _err(where, f"{field_name} 必須有字串欄位 file")
    thr = _num(v.get("threshold"), where, f"{field_name}.threshold", 0.0, 1.0, lo_open=True)
    return KeywordSpec(v["file"], thr)


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
    where = str(doc["lang"]) if isinstance(doc["lang"], str) and doc["lang"] else dir.name
    for k in ("lang", "templates_version"):
        if not isinstance(doc[k], str) or not doc[k]:
            raise _err(where, f"欄位 {k} 必須是非空字串")
    banner_roi = _int_list(doc["banner_roi"], 4, where, "banner_roi")
    spec_roi = _int_list(doc["spec_roi"], 4, where, "spec_roi")
    if banner_roi[2] <= 0 or banner_roi[3] <= 0 or spec_roi[2] <= 0 or spec_roi[3] <= 0:
        raise _err(where, "banner_roi／spec_roi 的寬高必須 > 0")
    for name in ("white", "red"):
        if not isinstance(doc[name], dict):
            raise _err(where, f"欄位 {name} 必須是物件")
    for k in ("v_min", "s_max"):
        _num(doc["white"].get(k), where, f"white.{k}", 0, 255)
    for k in ("r_min", "g_max", "b_max"):
        _num(doc["red"].get(k), where, f"red.{k}", 0, 255)
    if "r_diff_min" in doc["red"]:
        _num(doc["red"]["r_diff_min"], where, "red.r_diff_min", 0, 255)

    if not isinstance(doc["keywords"], dict):
        raise _err(where, "欄位 keywords 必須是物件")
    keywords = {k: _kw(v, where, f"keywords.{k}") for k, v in doc["keywords"].items()}
    missing = [k for k in REQUIRED_KEYWORDS if k not in keywords]
    if missing:
        raise _err(where, f"keywords 缺少必要範本：{', '.join(missing)}")
    if not isinstance(doc["spec_templates"], list):
        raise _err(where, "欄位 spec_templates 必須是陣列")
    specs = [_kw(v, where, "spec_templates[]") for v in doc["spec_templates"]]

    name_side = doc.get("name_side", "right")
    if name_side not in NAME_SIDES:
        raise _err(where, f"name_side 必須是 {NAME_SIDES}：{name_side!r}")
    if name_side == "left" and "skull" not in keywords:
        raise _err(where, "name_side=left 需要 keywords.skull 範本")
    between = doc.get("name_between_assist", False)
    if not isinstance(between, bool):
        raise _err(where, "name_between_assist 必須是布林值")
    spectating_supported = doc.get("spectating_supported", bool(specs))
    if not isinstance(spectating_supported, bool):
        raise _err(where, "spectating_supported 必須是布林值")
    if spectating_supported and not specs:
        raise _err(where, "spectating_supported=true 需要至少一個 spec_templates")
    if not spectating_supported and specs:
        raise _err(where, "spectating_supported=false 時 spec_templates 必須為空")

    line1 = _int_list(doc.get("line1_rows", (50, 108)), 2, where, "line1_rows")
    if not (line1[0] < line1[1] <= banner_roi[3]):
        raise _err(where, f"line1_rows 必須滿足 0 ≤ y0 < y1 ≤ banner 高度：{line1}")
    damage_depth = int(_num(doc.get("damage_depth", 40), where, "damage_depth", 0))
    p = Profile(
        lang=doc["lang"], templates_version=doc["templates_version"],
        banner_roi=banner_roi, spec_roi=spec_roi,  # type: ignore[arg-type]
        white=doc["white"], red=doc["red"], keywords=keywords, spec_templates=specs,
        name_sig_threshold=_num(doc["name_sig_threshold"], where, "name_sig_threshold", 0.0, 1.0,
                                lo_open=True),
        dedupe_window=_num(doc["dedupe_window"], where, "dedupe_window", 0.0, lo_open=True),
        line1_rows=line1,  # type: ignore[arg-type]
        damage_depth=damage_depth, name_side=name_side, name_between_assist=between,
        spectating_supported=spectating_supported, dir=dir)
    for spec in [*keywords.values(), *specs]:
        if not (dir / spec.file).exists():
            raise ProfileError(f"範本檔遺失：{spec.file}")
    return p


LANG_ORDER = ("zh-TW", "en", "ja")


def _load_named(sub: Path) -> Profile:
    try:
        return load_profile(sub)
    except ProfileError as e:
        raise ProfileError(f"語言「{sub.name}」的設定檔無法載入（{sub}）：{e}") from e


def resolve_profiles(dir: Path) -> list[Profile]:
    """載入單一語言設定檔，或自動偵測模式（auto / templates 根目錄）下載入所有語言設定檔。

    自動模式下任何一個語言的設定檔壞掉都會直接丟出 ProfileError，訊息點名是哪個語言。"""
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
                subs.append(_load_named(sub))
                seen.add(lang)
        for sub in sorted(root.iterdir()):
            if sub.is_dir() and sub.name not in seen and (sub / "profile.json").exists():
                subs.append(_load_named(sub))
        if subs:
            return subs
    raise ProfileError(f"profile.json 不存在：{dir / 'profile.json'}")
