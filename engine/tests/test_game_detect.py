"""Game recognition on frames: real Apex scene crops (fixtures/matches) and a synthetic Valorant scoreboard."""
import cv2
import numpy as np

from aditor.game_detect import count_hits, pick_game
from aditor.valorant import ENEMY_STRIP, SCORE_BOX
from test_scene import SCREENS, load_screen


def apex_frames(kinds=("pre_match", "lobby", "in_match_hud")):
    for item in SCREENS["frames"]:
        if item["scene"] in kinds:
            yield cv2.cvtColor(cv2.resize(load_screen(item), (1920, 1080)), cv2.COLOR_GRAY2BGR)


def valorant_frame():
    frame = np.full((1080, 1920, 3), (40, 50, 60), np.uint8)
    x, y, w, h = SCORE_BOX
    frame[y:y + h, x:x + w] = (150, 140, 140)
    x, y, w, h = ENEMY_STRIP
    frame[y:y + h, x:x + w] = (70, 80, 240)
    return frame


def test_apex_scenes_are_recognised_as_apex():
    frames = list(apex_frames())
    assert len(frames) >= 3
    hits = count_hits(frames)
    # Upscaling the 640x360 fixtures to 1080p and back costs at most a frame; none may look like Valorant.
    assert hits["apex"] >= len(frames) - 1 and hits["valorant"] == 0
    assert pick_game(hits) == "apex"


def test_valorant_scoreboard_is_recognised_as_valorant():
    hits = count_hits([valorant_frame()] * 4)
    assert hits == {"apex": 0, "valorant": 4}
    assert pick_game(hits) == "valorant"


def test_footage_of_neither_game_is_unknown():
    plain = [np.full((1080, 1920, 3), v, np.uint8) for v in (0, 90, 200)]
    other = list(apex_frames(("other",)))
    assert pick_game(count_hits(plain + other)) is None
