from __future__ import annotations

import base64
from dataclasses import asdict, dataclass, field, fields

import numpy as np

# 引擎只輸出 knock／assist_knock／assist_elim；elim 保留在計數類型內只為相容舊專案檔與手動事件
COUNTING_TYPES = frozenset({"knock", "assist_knock", "assist_elim", "elim"})


@dataclass(frozen=True)
class VideoInfo:
    path: str
    duration: float
    width: int
    height: int
    codec: str
    start_time: float
    size: int
    mtime: float

    def to_dict(self) -> dict:
        return asdict(self)


class NameSig:
    """敵人名字字形指紋：高度固定 16 的 0/1 陣列。"""

    HEIGHT = 16

    def __init__(self, width: int, bits: np.ndarray):
        self.width = width
        self.bits = bits

    def to_b64(self) -> str:
        packed = np.packbits(self.bits.astype(np.uint8).reshape(-1))
        return f"{self.width}:{base64.b64encode(packed.tobytes()).decode('ascii')}"

    @classmethod
    def from_b64(cls, s: str) -> "NameSig":
        w, b = s.split(":", 1)
        width = int(w)
        raw = np.frombuffer(base64.b64decode(b), dtype=np.uint8)
        bits = np.unpackbits(raw)[: cls.HEIGHT * width].reshape(cls.HEIGHT, width)
        return cls(width, bits.astype(np.uint8))


@dataclass
class FrameResult:
    kind: str | None
    score: float
    x: int
    damage_line: bool
    name_sig: NameSig | None
    spectating: bool
    # kind 為 None 時的提示：cont＝有加分箭頭與「+」但人形不確定（淡入淡出），延續進行中的事件（不算命中）。
    hint: str | None = None


@dataclass
class Event:
    id: str
    t: float
    type: str
    score: float
    damage_line: bool
    name_sig: str | None
    counted: bool = False
    counted_reason: str = ""
    counted_override: bool | None = None
    source: str = "auto"
    deleted: bool = False

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Event":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class SpecInterval:
    start: float
    end: float

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SpecInterval":
        return cls(start=d["start"], end=d["end"])


@dataclass
class Clip:
    id: str
    start: float
    end: float
    origin: str
    event_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Clip":
        return cls(id=d["id"], start=d["start"], end=d["end"], origin=d["origin"],
                   event_ids=list(d.get("event_ids", [])))


@dataclass
class AutoClipParams:
    gap: float = 20.0
    n: int = 3
    before: float = 8.0
    after: float = 4.0
    max_len: float = 90.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "AutoClipParams":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})
