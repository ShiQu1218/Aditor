"""Control kill-feed crops from the user's 2026-10-24 recording; timestamps are video seconds."""
import gzip
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from aditor.control_feed import ControlFeed
from aditor.live import LiveKills

FIXTURES = Path(__file__).parent / 'fixtures' / 'control_feed'


def read(t, kind):
    key = str(float(t)).replace('.', '_')
    return cv2.imdecode(np.fromfile(str(FIXTURES / f'{key}_{kind}.png'), np.uint8), cv2.IMREAD_COLOR)


@pytest.mark.parametrize('t,count', [(1745, 0), (1807.75, 1), (1808, 1), (1810.25, 1),
                                           (1874, 1), (1874.25, 1), (1880, 2)])
def test_actual_self_kills(profile, t, count):
    detector = ControlFeed(profile)
    assert len(detector.rows(read(t, 'feed'), read(t, 'spec'))) == count


def test_feed_cannot_claim_another_players_kills(profile):
    other = cv2.imdecode(np.fromfile(str(FIXTURES.parent / 'mixtape' / 'assist_spec.png'), np.uint8), cv2.IMREAD_COLOR)
    detector = ControlFeed(profile)
    assert detector.rows(read(1808, 'feed'), other) == []
    assert detector.rows(read(1808, 'feed'), np.zeros_like(other)) == []
    feed = read(1808, 'feed')
    feed[150:180, 828:900] = 0  # Remove the weapon between the local player and the victim.
    assert detector.rows(feed, read(1808, 'spec')) == []


def test_live_publishes_each_gold_kill_without_waiting_for_banner_learning(profile):
    live = LiveKills(profile)
    banner = np.zeros((180, 800, 3), np.uint8)
    for t in (1745, 1807.75, 1808, 1810.25, 1874, 1874.25):
        live.feed(t, banner, read(t, 'spec'), read(t, 'feed'))
    events, _ = live.snapshot()
    assert live.phase == 'calibrating'
    assert [(e.t, e.type, e.counted) for e in events] == [(1807.75, 'kill', True), (1874, 'kill', True)]
    final, _ = live.finish()
    assert [e.to_dict() for e in final] == [e.to_dict() for e in events]


def test_a_fading_moving_row_is_counted_once_and_a_later_respawn_counts_again(profile, monkeypatch):
    detector = ControlFeed(profile)
    detector.active = True
    feed = np.zeros_like(read(1745, 'feed'))
    spec = read(1808, 'spec')
    with gzip.open(FIXTURES / 'trace.json.gz', 'rt') as f:
        trace = json.load(f)
    for t, rows in trace:
        monkeypatch.setattr(detector, 'rows', lambda *_: [np.array(m, np.float32) for m in rows])
        detector.feed(t, feed, spec)
    assert [e.t for e in detector.events] == [1807.75, 1862]
    sig = ControlFeed(profile).rows(read(1808, 'feed'), spec)[0]
    monkeypatch.setattr(detector, 'rows', lambda *_: [sig])
    later = trace[-1][0] + 2.25
    detector.feed(later, feed, spec)
    detector.feed(later + 0.25, feed, spec)
    assert [e.t for e in detector.events] == [1807.75, 1862, later]


def test_lobby_disarms_control_before_the_next_mode(profile):
    from test_scene import SCREENS, load_screen
    detector = ControlFeed(profile)
    detector.feed(0, read(1745, 'feed'), read(1745, 'spec'))
    assert detector.active
    lobby = load_screen(next(f for f in SCREENS['frames'] if f['scene'] == 'lobby'))
    detector.feed(1, np.zeros_like(read(1745, 'feed')), read(1745, 'spec'), lobby)
    assert not detector.active
    for t in (2, 2.25):
        detector.feed(t, read(1808, 'feed'), read(1808, 'spec'))
    assert detector.events == []


def test_live_and_segmented_offline_share_immediate_kills(tmp_path, profile):
    from aditor import ffbin
    from aditor.analyze import analyze
    from aditor.decode import FrameStream
    from aditor.layout import Layout

    frames = []
    for t in (1745, 1808, 1808, 1745, 1745, 1745, 1745, 1745, 1874.25, 1874.25, 1745, 1745):
        frame = np.zeros((1080, 1920, 3), np.uint8)
        frame[60:480, 850:1920] = read(t, 'feed')
        frame[950:1068, 60:540] = read(t, 'spec')
        frames.append(frame.tobytes())
    video = tmp_path / 'control.mp4'
    result = subprocess.run([ffbin.ffmpeg(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                             '-s', '1920x1080', '-r', '1', '-i', 'pipe:0', '-vf', 'fps=4', '-c:v', 'libopenh264',
                             '-b:v', '40M', '-allow_skip_frames', '0', str(video)],
                            input=b''.join(frames), capture_output=True)
    assert result.returncode == 0, result.stderr
    live = LiveKills(profile)
    stream = FrameStream(str(video), profile, hwaccel=False)
    for t, banner, spec in stream:
        live.feed(t, banner, spec, stream.killfeed, stream.thumb if round(t * 4) % 4 == 0 else None)
    events, _ = live.finish()
    assert [(e.t, e.type, e.counted) for e in events] == [(1, 'kill', True), (8, 'kill', True)]
    for jobs in (1, 2):
        doc = analyze(str(video), profile, cache_dir=tmp_path / f'cache{jobs}', force=True, jobs=jobs,
                      layout=Layout(1), game='apex', hwaccel=False)
        assert [(e['t'], e['type'], e['counted']) for e in doc['events']] == [(1, 'kill', True), (8, 'kill', True)]
        assert doc['events'] == [e.to_dict() for e in events]
