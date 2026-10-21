import cv2
import numpy as np

from aditor.models import Event
from aditor.valorant_rounds import ALLY_DIGITS, ENEMY_DIGITS, Round, RoundTracker, round_highlights

ORIGIN, SIZE = (740, 20), (460, 64)   # The profile's spec crop: x, y and w, h.
FPS = 4.0


def board(ally, enemy, background=60):
    """The top scoreboard crop with each score drawn in white on a translucent grey box; None hides the board."""
    img = np.full((SIZE[1], SIZE[0], 3), background, np.uint8)
    for score, (x, y, w, h) in ((ally, ALLY_DIGITS), (enemy, ENEMY_DIGITS)):
        if score is None:
            continue
        x, y = x - ORIGIN[0], y - ORIGIN[1]
        cv2.rectangle(img, (x, y), (x + w - 1, y + h - 1), (150, 145, 140), -1)
        cv2.putText(img, str(score), (x + 6, y + h - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
    return img


def play(script):
    """script: (seconds, ally, enemy) segments; returns the tracker after feeding them at 4 fps."""
    tr, t = RoundTracker(ORIGIN, FPS), 0.0
    for seconds, ally, enemy in script:
        for _ in range(int(seconds * FPS)):
            tr.feed(t, board(ally, enemy) if ally is not None or enemy is not None else board(None, None))
            t += 1 / FPS
    return tr


def scores(tr):
    return [(r.winner, r.ally, r.enemy) for r in tr.rounds]


def test_each_held_score_change_is_a_round_for_that_side():
    tr = play([(40, 0, 0), (40, 0, 1), (40, 1, 1), (40, 2, 1)])
    assert scores(tr) == [("enemy", 0, 1), ("ally", 1, 1), ("ally", 2, 1)]
    assert tr.rounds[0].start == 0.0 and tr.rounds[1].start == tr.rounds[0].end


def test_flashes_and_returning_glyphs_are_not_rounds():
    # A 1 s glimpse of another score, and the board flicking back to an old score, are noise.
    tr = play([(40, 0, 0), (1, 5, 0), (40, 0, 0), (40, 1, 0), (5, 0, 0), (40, 1, 0)])
    assert scores(tr) == [("ally", 1, 0)]


def test_the_match_winning_score_shows_briefly_before_the_end_screen():
    tr = play([(40, 12, 9), (1, 13, 9), (90, None, None)])
    assert [r.winner for r in tr.rounds] == ["ally"]


def test_a_brief_mid_match_hide_is_not_the_last_round():
    tr = play([(40, 3, 4), (1, 4, 4), (5, None, None), (40, 3, 4)])
    assert tr.rounds == []


def test_a_new_match_counts_from_zero_again():
    tr = play([(40, 0, 0), (40, 1, 0), (120, None, None), (40, 0, 0), (40, 0, 1)])
    assert scores(tr) == [("ally", 1, 0), ("enemy", 0, 1)]


def test_multikills_and_aces_are_per_round_and_never_counted():
    def kill(t):
        return Event(id=f"k{t}", t=t, type="kill", score=1.0, damage_line=False, name_sig=None, counted=True)

    rounds = [Round(0, 100, "ally", 1, 0), Round(100, 200, "enemy", 1, 1), Round(200, 300, "ally", 2, 1)]
    events = [kill(10), kill(20), kill(110)] + [kill(210 + i) for i in range(5)]
    out = round_highlights(events, rounds)
    assert [(e.type, e.score, e.t, e.counted) for e in out] == [("multikill", 2.0, 20, False), ("ace", 5.0, 214, False)]
