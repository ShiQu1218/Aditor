"""Phase C oracle helpers; run through dump_parity.py --phase-c."""
import hashlib
import importlib
import inspect
import itertools
import json
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'engine/tests/parity/phase_c'


def dump():
    from aditor import scene, matches, valorant, valorant_rounds, profile, live
    sys.path.insert(0, str(ROOT / 'engine/tests'))
    OUT.mkdir(exist_ok=True)
    p = profile.load_profile(ROOT / 'templates/icons')
    doc = dict(scene=[], match_traces=[], frames={}, rows={}, detections=[], feed_traces=[], round_traces=[], highlights=[], merges=[], live_kills=[])
    existing = {}
    for path in (ROOT / 'engine/tests/fixtures').rglob('*.png'):
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is not None:
            existing[hashlib.sha256(img.tobytes()).hexdigest()[:16]] = path.relative_to(ROOT / 'engine/tests').as_posix()
    def frame(img):
        key = hashlib.sha256(img.tobytes()).hexdigest()[:16]
        if key not in doc['frames']:
            if key in existing:
                doc['frames'][key] = existing[key]
            else:
                name = key + '.png'
                assert cv2.imwrite(str(OUT / name), img)
                doc['frames'][key] = 'parity/phase_c/' + name
        return key
    def row(r):
        v = dict(slot=r.slot, type=r.type, signature=r.signature.tolist(), confirmed=r.confirmed,
                 identity=r.identity.tolist() if r.identity is not None else None)
        key = hashlib.sha256(json.dumps(v).encode()).hexdigest()[:16]
        doc['rows'][key] = v
        return key
    def result(pair):
        return dict(events=[e.to_dict() for e in pair[0]], spectating=[s.to_dict() for s in pair[1]])
    import test_scene
    detector = scene.SceneDetector()
    for item in test_scene.SCREENS['frames']:
        img = test_scene.load_screen(item)
        doc['scene'].append(dict(file=item['file'], full=asdict(detector.classify(img)), fast=asdict(detector.classify(img, full_scores=False))))
    original_match = matches.MatchTracker
    class MatchSpy(original_match):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.trace = dict(period=kw.get('sample_period', 1.0), calls=[])
            doc['match_traces'].append(self.trace)
        def feed(self, t, s):
            call = dict(op='feed', t=t, scene=asdict(s))
            self.trace['calls'].append(call)
            try:
                ev = super().feed(t, s)
                call['events'] = [asdict(e) for e in ev]
                return ev
            except ValueError as e:
                call['error'] = str(e)
                raise
        def finish(self, t):
            call = dict(op='finish', t=t)
            self.trace['calls'].append(call)
            try:
                ev = super().finish(t)
                call.update(events=[asdict(e) for e in ev], matches=[asdict(m) for m in self.matches])
                return ev
            except ValueError as e:
                call['error'] = str(e)
                raise
    mt = importlib.import_module('test_matches')
    mt.MatchTracker = MatchSpy
    doc['restores'] = []
    original_restore = valorant.ValorantProfile.restore
    def restore(self, b, s):
        rb, rs = original_restore(self, b, s)
        doc['restores'].append(dict(squash=self.layout.squash, banner=frame(b), spec=frame(s), expected_banner=frame(rb), expected_spec=frame(rs)))
        return rb, rs
    valorant.ValorantProfile.restore = restore
    original_observe = valorant.FeedDetector.observations
    def observe(self, img):
        rows = original_observe(self, img)
        doc['detections'].append(dict(frame=frame(img), rows=[row(r) for r in rows]))
        return rows
    valorant.FeedDetector.observations = observe
    original_tracker = valorant.FeedTracker
    class FeedSpy(original_tracker):
        def __init__(self):
            super().__init__()
            self.trace = []
            doc['feed_traces'].append(self.trace)
        def feed(self, t, rows):
            rows = list(rows)
            ev = super().feed(t, rows)
            self.trace.append(dict(t=t, rows=[row(r) for r in rows], new=[e.to_dict() for e in ev], events=[e.to_dict() for e in self.events]))
            return ev
    vt = importlib.import_module('test_valorant')
    vt.FeedTracker = FeedSpy
    original_round = valorant_rounds.RoundTracker
    class RoundSpy(original_round):
        def __init__(self, origin, fps=4.0):
            super().__init__(origin, fps)
            self.trace = dict(origin=origin, fps=fps, calls=[])
            doc['round_traces'].append(self.trace)
        def feed(self, t, img):
            ev = super().feed(t, img)
            self.trace['calls'].append(dict(t=t, frame=frame(img), new=ev.to_dict() if ev else None))
            self.trace['rounds'] = [r.to_dict() for r in self.rounds]
            return ev
    rt = importlib.import_module('test_valorant_rounds')
    rt.RoundTracker = RoundSpy
    original_highlights = rt.round_highlights
    def highlights(events, rounds):
        out = original_highlights(events, rounds)
        doc['highlights'].append(dict(events=[e.to_dict() for e in events], rounds=[r.to_dict() for r in rounds], expected=[e.to_dict() for e in out]))
        return out
    rt.round_highlights = highlights
    original_merge = valorant.merge_events
    def merge(base, detected, rounds):
        out, lost = original_merge(base, detected, rounds)
        doc['merges'].append(dict(base=[e.to_dict() for e in base], detected=[e.to_dict() for e in detected], rounds=[r.to_dict() for r in rounds], events=[e.to_dict() for e in out], lost=[e.to_dict() for e in lost]))
        return out, lost
    valorant.merge_events = merge
    executed, omitted = [], []
    for module in (mt, vt, rt):
        for name, fn in vars(module).copy().items():
            if not name.startswith('test_') or not callable(fn):
                continue
            args = inspect.signature(fn).parameters
            if any(a not in ('tmp_path', 'monkeypatch') for a in args):
                params = {}
                for mark in getattr(fn, 'pytestmark', []):
                    if mark.name == 'parametrize':
                        names = mark.args[0].replace(' ', '').split(',')
                        params[tuple(names)] = mark.args[1]
                if any(a not in ('tmp_path', 'monkeypatch') and not any(a in ns for ns in params) for a in args):
                    omitted.append(module.__name__ + '.' + name)
                    continue
            else:
                params = {}
            if name != 'test_reanalysis_recomputes_multikills_from_the_users_kill_edits' and any(token in name for token in ('cli_', 'hardware_', 'generator_', 'decoder_', 'acceptance', 'analysis_', 'profile_', 'live_', 'resolves_recorded', 'detects_the_aspect', 'real_scene_decoder')):
                omitted.append(module.__name__ + '.' + name)
                continue
            combos = itertools.product(*params.values()) if params else [()]
            for combo in combos:
                kw = {}
                for names, values in zip(params, combo):
                    values = values if len(names) > 1 else (values,)
                    kw.update(zip(names, values))
                with tempfile.TemporaryDirectory(dir=ROOT / 'engine/target') as temp, pytest.MonkeyPatch.context() as mp:
                    if 'tmp_path' in args: kw['tmp_path'] = Path(temp)
                    if 'monkeypatch' in args: kw['monkeypatch'] = mp
                    fn(**kw)
                executed.append(module.__name__ + '.' + name)
    from aditor.control_feed import ControlFeed
    import test_control_feed as ct
    import gzip
    control = ControlFeed(p)
    control.active = True
    with gzip.open(ct.FIXTURES / 'trace.json.gz', 'rt') as f:
        trace = json.load(f)
    doc['control_rows'] = {}
    def control_row(m):
        a = np.array(m, np.float32)
        key = hashlib.sha256(a.tobytes()).hexdigest()[:16]
        doc['control_rows'][key] = dict(width=a.shape[1], height=a.shape[0], nonzero=[[int(i), float(a.flat[i])] for i in np.flatnonzero(a)])
        return key
    doc['control_trace'] = [dict(t=t, rows=[control_row(m) for m in rows]) for t, rows in trace]
    blank = np.zeros((180, 800, 3), np.uint8)
    calls = []
    lk = live.LiveKills(p)
    for t in (1745, 1807.75, 1808, 1810.25, 1874, 1874.25):
        b, s, f = blank, ct.read(t, 'spec'), ct.read(t, 'feed')
        lk.feed(t, b, s, f)
        calls.append(dict(t=t, banner=frame(b), spec=frame(s), killfeed=frame(f), snapshot=result(lk.snapshot())))
    doc['live_kills'].append(dict(calls=calls, final=result(lk.finish()), degraded=lk.degraded, scale=lk.h_scale))
    import test_mixtape as mix
    for kind in ('kill', 'assist'):
        lk = live.LiveKills(p)
        calls = []
        b = cv2.imread(str(mix.FIXTURES / f'{kind}_banner.png'))
        s = cv2.imread(str(mix.FIXTURES / f'{kind}_spec.png'))
        for t in (0., 0.25, 0.5, 1., 2.):
            lk.feed(t, b, s)
            calls.append(dict(t=t, banner=frame(b), spec=frame(s), snapshot=result(lk.snapshot())))
        doc['live_kills'].append(dict(calls=calls, final=result(lk.finish()), degraded=lk.degraded, scale=lk.h_scale))
    dump_offline(doc, p)
    doc['executed_pytest_cases'] = executed
    doc['native_counterpart_cases'] = omitted
    # Nonfinite validation inputs are strings, not invalid JSON numbers.
    def clean(x):
        if isinstance(x, float) and not np.isfinite(x): return 'nan' if np.isnan(x) else 'inf' if x > 0 else '-inf'
        if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)): return [clean(v) for v in x]
        return x
    (OUT / 'cases.json').write_text(json.dumps(clean(doc), separators=(',', ':')), encoding='utf-8')
    (OUT / 'reference.json').write_text(json.dumps(dict(executable=sys.executable, python=sys.version, opencv=cv2.__version__, numpy=np.__version__)), encoding='utf-8')
    used = {Path(v).name for v in doc['frames'].values() if v.startswith('parity/phase_c/')}
    for path in OUT.glob('*.png'):
        if path.name not in used: path.unlink()
    total = sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())
    print(f'Phase C: {len(executed)} pytest cases, {len(doc["frames"])} crops, {total} bytes')
    assert total < 5_000_000, total


def dump_offline(doc, apex):
    import subprocess
    from aditor import ffbin, matches, layout, probe, valorant
    import test_scene
    target = ROOT / 'engine/target'
    def video(path, width, height, fmt, fps, frames):
        subprocess.run([ffbin.ffmpeg(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', fmt, '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0', '-c:v', 'ffv1', str(path)], input=b''.join(frames), check=True)
    def portable(d):
        d.pop('cache_path', None)
        d['video'].pop('path', None)
        d['video'].pop('mtime', None)
        return d
    kinds = ['pre_match', 'in_match_hud', 'in_match_hud', 'lobby', 'other', 'other', 'other', 'in_match_hud']
    items = [next(c for c in test_scene.SCREENS['frames'] if c['scene'] == k) for k in kinds]
    path = target / 'phase-c-matches.mkv'
    video(path, 640, 360, 'gray', 1, [test_scene.load_screen(c).tobytes() for c in items])
    doc['matches_video'] = dict(files=[c['file'] for c in items], expected=[matches.analyze_matches(str(path), timeline=t, hwaccel=False, layout=layout.Layout(1)) for t in (False, True)])
    vp = valorant.load_valorant_profile(ROOT / 'templates/valorant/icons')
    detections = doc['detections'][:8]
    board_id = doc['round_traces'][0]['calls'][0]['frame']
    def read(key): return cv2.imread(str(ROOT / 'engine/tests' / doc['frames'][key]))
    frames = []
    for c in detections:
        f = np.zeros((1080, 1920, 3), np.uint8)
        f[84:340, 1316:1916] = read(c['frame'])
        f[20:84, 740:1200] = read(board_id)
        frames.append(f.tobytes())
    path = target / 'phase-c-valorant.mkv'
    video(path, 1920, 1080, 'bgr24', 4, frames)
    with tempfile.TemporaryDirectory(dir=target) as tmp:
        expected = valorant.analyze_valorant(str(path), probe.probe(str(path)), vp, cache_dir=Path(tmp), force=True, hwaccel=False)
    doc['valorant_video'] = dict(feeds=[c['frame'] for c in detections], board=board_id, expected=portable(expected))

    import test_control_feed as ct
    from aditor.analyze import analyze
    sequence = [1745, 1808, 1808, 1745, 1745, 1745, 1745, 1745, 1874.25, 1874.25, 1745, 1745]
    frames = []
    for t in sequence:
        f = np.zeros((1080, 1920, 3), np.uint8)
        f[60:480, 850:1920] = ct.read(t, 'feed')
        f[950:1068, 60:540] = ct.read(t, 'spec')
        frames.append(f.tobytes())
    path = target / 'phase-c-control.mkv'
    video(path, 1920, 1080, 'bgr24', 1, frames)
    with tempfile.TemporaryDirectory(dir=target) as tmp:
        expected = [portable(analyze(str(path), apex, cache_dir=Path(tmp) / str(jobs), force=True, jobs=jobs,
                                    hwaccel=False, game='apex', layout=layout.Layout(1))) for jobs in (1, 2)]
    doc['control_video'] = dict(times=sequence, expected=expected)


def benchmark():
    import time
    from aditor.profile import load_profile
    from aditor.live import LiveKills
    from aditor.scene import SceneDetector
    sys.path.insert(0, str(ROOT / 'engine/tests'))
    from test_scene import load_screen, SCREENS
    cv2.setNumThreads(1)
    p = load_profile(ROOT / 'templates/icons')
    doc = json.loads((OUT / 'cases.json').read_text(encoding='utf-8'))
    call = doc['live_kills'][1]['calls'][0]
    read = lambda k: cv2.imread(str(ROOT / 'engine/tests' / doc['frames'][call[k]]))
    b, s = read('banner'), read('spec')
    f, scene = load_screen(SCREENS['frames'][0]), SceneDetector()
    times = []
    for _ in range(3):
        kills = LiveKills(p)
        start = time.process_time()
        for i in range(20):
            kills.feed(i * .25, b, s)
            if i % 4 == 0: scene.classify(f, full_scores=False)
        times.append((time.process_time() - start) * 1000 / 20)
    result = dict(python_ms=sorted(times)[1], runs=times)
    (ROOT / 'engine/target/phase-c-python-performance.json').write_text(json.dumps(result), encoding='utf-8')
    print(json.dumps(result))


def audit():
    """Export mutated Mixtape/keyword inputs that the original crop sweep cannot cover."""
    from aditor import detect, events, profile
    sys.path.insert(0, str(ROOT / 'engine/tests'))
    import test_mixtape as mix
    import test_keywords as keywords
    p = profile.load_profile(ROOT / 'templates/icons')
    doc = dict(frames={}, detections=[], traces=[], executed=[])
    base = json.loads((OUT / 'cases.json').read_text(encoding='utf-8'))
    known = {}
    for path in itertools.chain((ROOT / 'engine/tests/fixtures').rglob('*.png'), (ROOT / 'engine/tests/parity/mixtape').rglob('*.png')):
        img = cv2.imread(str(path))
        if img is not None:
            known[hashlib.sha256(img.tobytes()).hexdigest()[:16]] = path.relative_to(ROOT / 'engine/tests').as_posix()
            if img.shape[0] > 180 and img.shape[1] >= 800:
                for x, y, w, h in [(0, 0, img.shape[1], 180), (0, 180, 480, min(118, img.shape[0] - 180))]:
                    crop = img[y:y+h, x:x+w]
                    known[hashlib.sha256(crop.tobytes()).hexdigest()[:16]] = dict(file=path.relative_to(ROOT / 'engine/tests').as_posix(), rect=[x, y, w, h])
    def frame(img):
        key = hashlib.sha256(img.tobytes()).hexdigest()[:16]
        if key not in doc['frames']:
            path = known.get(key, base['frames'].get(key))
            if path is None:
                path = 'parity/phase_c/audit_' + key + '.png'
                assert cv2.imwrite(str(ROOT / 'engine/tests' / path), img)
            doc['frames'][key] = path
        return key
    class Detector(detect.Detector):
        def __init__(self, profile, icon_scale=1., **kw):
            super().__init__(profile, icon_scale, **kw)
            self.scale = icon_scale
        def detect(self, b, s):
            out = super().detect(b, s)
            doc['detections'].append(dict(banner=frame(b), spec=frame(s), scale=self.scale,
                keywords=self.keywords.to_dict() if self.keywords else None,
                expected={**asdict(out), 'name_sig': out.name_sig.to_b64() if out.name_sig else None}))
            return out
    class Tracker(events.EventTracker):
        def __init__(self, profile):
            super().__init__(profile)
            self.trace = dict(frames=[])
            doc['traces'].append(self.trace)
        def feed(self, t, result):
            self.trace['frames'].append([t, {**asdict(result), 'name_sig': result.name_sig.to_b64() if result.name_sig else None}])
            super().feed(t, result)
        def finish(self):
            out = super().finish()
            self.trace['expected'] = [[asdict(e) for e in out[0]], [asdict(s) for s in out[1]]]
            return out
    for module in (mix, keywords):
        module.Detector = Detector
        if module is mix:
            module.EventTracker = Tracker
        for name, fn in vars(module).copy().items():
            if not name.startswith('test_'):
                continue
            params = {}
            for mark in getattr(fn, 'pytestmark', []):
                if mark.name == 'parametrize':
                    params[tuple(mark.args[0].replace(' ', '').split(','))] = mark.args[1]
            for combo in itertools.product(*params.values()) if params else [()]:
                kw = dict(profile=p, zh_kw=keywords.zh_kw.__wrapped__(p)) if 'zh_kw' in inspect.signature(fn).parameters else dict(profile=p)
                for names, values in zip(params, combo):
                    kw.update(zip(names, values if len(names) > 1 else (values,)))
                fn(**{k: v for k, v in kw.items() if k in inspect.signature(fn).parameters})
                doc['executed'].append(module.__name__ + '.' + name)
    doc['traces'] = [t for t in doc['traces'] if 'expected' in t]
    assert len(doc['executed']) == 38 and doc['detections'] and doc['traces']
    (OUT / 'audit.json').write_text(json.dumps(doc, separators=(',', ':')), encoding='utf-8')
    used = {v for v in doc['frames'].values() if isinstance(v, str)}
    for path in OUT.glob('audit_*.png'):
        if path.relative_to(ROOT / 'engine/tests').as_posix() not in used:
            path.unlink()
    total = sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())
    assert total < 5_000_000, total
    print(f'Audit: {len(doc["executed"])} pytest cases, {len(doc["detections"])} detections, {len(doc["traces"])} traces; Phase C {total} bytes')
