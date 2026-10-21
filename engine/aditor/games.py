"""Supported games (the app's shared/games.ts holds the same ids and template layout).

Apex keeps the original top-level templates/icons and templates/scene; other games live under templates/<game>/.
A recording's game comes from an explicit request, else its aditor_game tag, else Apex (all recordings made before
multi-game support are Apex and untagged).
"""
from __future__ import annotations

from pathlib import Path

from .models import VideoInfo

DEFAULT_GAME = "apex"
GAMES = ("apex", "valorant")
# Games whose detection pipeline is implemented; the others are recognised but cannot be analyzed yet.
ANALYZABLE = frozenset({"apex", "valorant"})


class UnsupportedGame(ValueError):
    pass


def parse_game(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    game = value.strip().lower()
    if game not in GAMES:
        raise UnsupportedGame(f"Unknown game: {value!r} (supported: {', '.join(GAMES)})")
    return game


def resolve_game(explicit: str | None, info: VideoInfo | None = None) -> str:
    """Explicit request > the video's aditor_game tag > Apex. An unknown tag is treated like no tag."""
    game = parse_game(explicit)
    if game is not None:
        return game
    tag = (info.game or "").strip().lower() if info is not None else ""
    return tag if tag in GAMES else DEFAULT_GAME


def require_analyzable(game: str) -> None:
    if game not in ANALYZABLE:
        raise UnsupportedGame(f"{game} analysis is not available yet")


def profile_dir_for(base: Path, game: str) -> Path:
    """`base` is the shipped Apex templates/icons directory."""
    base = Path(base)
    return base if game == DEFAULT_GAME else base.parent / game / "icons"
