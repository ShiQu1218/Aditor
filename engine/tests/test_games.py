import io
import json
from dataclasses import replace
from pathlib import Path

import pytest

from aditor import ENGINE_VERSION, cache
from aditor.__main__ import main
from aditor.games import UnsupportedGame, parse_game, profile_dir_for, require_analyzable, resolve_game
from aditor.live import run as run_live
from aditor.models import VideoInfo

INFO = VideoInfo(path="x.mp4", duration=1.0, width=1920, height=1080, codec="av1", start_time=0.0, size=10, mtime=100.0)


def test_game_resolution_prefers_explicit_then_tag_then_apex():
    assert resolve_game(None, INFO) == "apex"
    assert resolve_game(None, replace(INFO, game="valorant")) == "valorant"
    assert resolve_game(None, replace(INFO, game="Valorant ")) == "valorant"
    assert resolve_game(None, replace(INFO, game="csgo")) == "apex"  # Unknown tags count as untagged.
    assert resolve_game("apex", replace(INFO, game="valorant")) == "apex"
    assert parse_game("") is None
    with pytest.raises(UnsupportedGame):
        parse_game("csgo")


def test_implemented_games_are_analyzable():
    require_analyzable("apex")
    require_analyzable("valorant")


def test_profile_dirs_match_the_app_template_layout():
    base = Path("res") / "templates" / "icons"
    assert profile_dir_for(base, "apex") == base
    assert profile_dir_for(base, "valorant") == Path("res") / "templates" / "valorant" / "icons"


def test_cache_from_another_game_needs_reanalysis():
    doc = {"analysis": {"status": "done", "engine_version": ENGINE_VERSION, "templates_version": "v"},
           "video": {"size": 10, "mtime": 100.0}}
    assert not cache.needs_reanalysis(doc, INFO, "v")  # Untagged caches are Apex.
    assert cache.needs_reanalysis(doc, INFO, "v", game="valorant")
    assert not cache.needs_reanalysis({**doc, "game": "valorant"}, INFO, "v", game="valorant")


def test_live_engine_rejects_an_unknown_game_before_opening_shared_memory():
    out = io.BytesIO()
    code = run_live("Local\\aditor-missing", Path("unused"), stdin=io.BytesIO(), stdout=out, game="csgo")
    assert code == 1
    assert json.loads(out.getvalue().decode("utf-8").splitlines()[0])["code"] == "unsupported_game"


def test_cli_rejects_unknown_games(tmp_path, capsys):
    assert main(["analyze", str(tmp_path / "x.mp4"), "--profile-dir", str(tmp_path), "--cache-dir", str(tmp_path),
                 "--game", "csgo"]) == 1
    assert "Unknown game" in capsys.readouterr().err


def test_detection_needs_a_clear_winner():
    from aditor.game_detect import pick_game

    assert pick_game({"apex": 5, "valorant": 0}) == "apex"
    assert pick_game({"apex": 1, "valorant": 4}) == "valorant"
    assert pick_game({"apex": 2, "valorant": 1}) is None   # Too few frames for either.
    assert pick_game({"apex": 4, "valorant": 4}) is None   # Tie: let the user decide.


def test_unknown_and_unsupported_games_have_their_own_ipc_codes():
    from aditor.game_detect import UnknownGame
    from aditor.ipc import _code

    assert _code(UnknownGame("x")) == "unknown_game"
    assert _code(UnsupportedGame("x")) == "unsupported_game"
