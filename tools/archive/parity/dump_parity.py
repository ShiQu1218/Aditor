"""Regenerate the Phase A Rust parity oracle with the unchanged Python engine.

Run with the reference venv and PYTHONPATH=<repo>/engine. No runtime Rust dependency on Python.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from aditor import aspect, ffbin, games, layout, models, probe, profile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "engine/tests/parity"


def image(a):
    return {"width": a.shape[1], "height": a.shape[0],
            "channels": a.shape[2] if a.ndim == 3 else 1, "data": a.reshape(-1).tolist()}


def clean(value):
    if isinstance(value, float) and not np.isfinite(value):
        return "nan" if np.isnan(value) else "inf" if value > 0 else "-inf"
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(value), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")


def dump_cv():
    rng = np.random.default_rng(41027)
    cases = []

    def add(op, a, result, **params):
        cases.append(dict(op=op, dtype=str(a.dtype), input=image(a), expected=result, **params))

    arrays = [rng.integers(0, 256, (9, 13), np.uint8),
              rng.integers(0, 256, (8, 12, 3), np.uint8),
              np.zeros((5, 7), np.uint8), np.full((5, 7), 255, np.uint8),
              np.arange(15, dtype=np.uint8).reshape(1, 15),
              np.arange(15, dtype=np.uint8).reshape(15, 1)]
    arrays.append(rng.integers(0, 256, (3, 3), np.uint8))
    for base in (ROOT / "templates", ROOT / "engine/tests/fixtures"):
        for path in sorted(base.rglob("*.png"))[:3]:
            a = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)[:12, :17]
            arrays.append(a)
    for i, a in enumerate(arrays):
        if a.ndim == 3:
            add("gray", a, image(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)))
            add("hsv", a, image(cv2.cvtColor(a, cv2.COLOR_BGR2HSV)))
            add("in_range", a, image(cv2.inRange(a, (20, 90, 150), (180, 255, 255))), low=[20, 90, 150], high=[180, 255, 255])
        for dtype in (np.uint8, np.float32):
            src = a if dtype == np.uint8 else a.astype(dtype) / 255
            for method, flag in (("area", cv2.INTER_AREA), ("linear", cv2.INTER_LINEAR)):
                for w, h in ((3, 2), (a.shape[1] * 2, a.shape[0] * 2), (a.shape[1], a.shape[0])):
                    add("resize", src, image(cv2.resize(src, (w, h), interpolation=flag)), width=w, height=h, method=method)
                for scale in (0.9, 0.95, 1.05, 1.1):
                    add("resize_factor", src, image(cv2.resize(src, None, fx=scale, fy=scale, interpolation=flag)), scale=scale, method=method)
            for k, sigma in ((3, 0.8), (3, 0.0), (5, 0.0), (7, 0.0)):
                add("gaussian", src, image(cv2.GaussianBlur(src, (k, k), sigma)), kernel=k, sigma=sigma)
            add("split", src, [image(v) for v in cv2.split(src)])
            add("border", src, image(cv2.copyMakeBorder(src, 1, 2, 3, 1, cv2.BORDER_CONSTANT)))
            if dtype == np.float32:
                for kernel in ((3, 3), (4, 2), (7, 5)):
                    add("box", src, image(cv2.boxFilter(src, -1, kernel, anchor=(0, 0))), kernel=kernel)
        for k in (3, 5, 7):
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
            for name, flag in (("open", cv2.MORPH_OPEN), ("tophat", cv2.MORPH_TOPHAT), ("blackhat", cv2.MORPH_BLACKHAT)):
                add("morphology", a, image(cv2.morphologyEx(a, flag, kernel)), kernel=k, method=name)
            for iterations in (1, 2):
                add("dilate", a, image(cv2.dilate(a, kernel, iterations=iterations)), kernel=k, iterations=iterations)
        png = OUT / "cv" / f"crop-{i}.png"
        png.parent.mkdir(parents=True, exist_ok=True)
        ok, buf = cv2.imencode(".png", a)
        assert ok
        png.write_bytes(buf.tobytes())
        for gray in (False, True):
            add("png", a, image(cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE if gray else cv2.IMREAD_COLOR)), file=png.name, gray=gray)
    # Integer-scale INTER_AREA has a separate half-up 2x2 fast path.
    for channels in (1, 3):
        shape = (8, 12) if channels == 1 else (8, 12, channels)
        a = rng.integers(0, 256, shape, np.uint8)
        for factor in (2, 4):
            add("resize", a, image(cv2.resize(a, (12 // factor, 8 // factor), interpolation=cv2.INTER_AREA)), width=12 // factor, height=8 // factor, method="area")
    for a in (rng.integers(0, 256, (10, 14), np.uint8), rng.random((10, 14), dtype=np.float32),
              np.ones((10, 14), np.float32), np.zeros((10, 14), np.float32),
              rng.integers(0, 256, (10, 14, 3), np.uint8)):
        for tpl in (a[2:6, 3:8].copy(), np.ones_like(a[:4, :5]), np.zeros_like(a[:4, :5])):
            for masked in (False, True):
                mask = rng.integers(0, 2, (4, 5), np.uint8) * 255 if masked else None
                result = cv2.matchTemplate(a, tpl, cv2.TM_CCOEFF_NORMED, mask=mask)
                add("match", a, image(result), template=image(tpl), mask=image(mask) if masked else None)
                add("min_max", result, cv2.minMaxLoc(result))
    for _ in range(20):
        a = (rng.random((11, 17)) > 0.75).astype(np.uint8)
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(a, connectivity=8)
        add("components", a, dict(labels=image(labels), stats=stats.tolist(), centroids=centroids.tolist()))
    for a in (np.zeros((3, 4), np.uint8), np.ones((3, 4), np.uint8)):
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(a, connectivity=8)
        add("components", a, dict(labels=image(labels), stats=stats.tolist(), centroids=centroids.tolist()))
    write(OUT / "cv/cases.json", cases)


def dump_modules():
    layouts = []
    for name in layout.SUPPORTED_ASPECTS:
        lay = layout.parse_aspect(name)
        for rect, anchor in layout.CAPTURE_SPEC.values():
            layouts.append(dict(name=name, rect=rect, anchor=anchor, squash=lay.squash,
                                source=lay.source_rect(rect, anchor), capture=layout.capture_rect(rect, anchor)))
    p = profile.load_profile(ROOT / "templates/icons")
    doc = asdict(p)
    doc.pop("dir")
    doc.update(capture_banner=p.capture_banner, capture_spec=p.capture_spec, capture_killfeed=p.capture_killfeed)
    stats = [{"16:9": (0, 0), "4:3": (2, 9)}, {"16:9": (0, 0), "4:3": (3, 1)},
             {"16:9": (5, 1), "4:3": (5, 9)}, {"16:9": (0, 0), "4:3": (6, 3), "5:4": (6, 4.5)}]
    from aditor.scene import SCENE_ROIS, SCENE_SIZE
    scene_dir = ROOT / "engine/tests/fixtures/matches"
    screens = json.loads((scene_dir / "screens.json").read_text(encoding="utf-8"))
    frames = []
    for item in screens["frames"]:
        if item["scene"] not in ("in_match_hud", "lobby"):
            continue
        atlas = cv2.imdecode(np.fromfile(str(scene_dir / item["file"]), np.uint8), cv2.IMREAD_GRAYSCALE)
        frame = np.zeros((360, 640), np.uint8)
        row = 0
        for _, x, y, w, h in screens["rois"]:
            frame[y:y + h, x:x + w] = atlas[row:row + h, :w]
            row += h
        frames.append(frame)
    aspect_frames = []
    for name, ratio in layout.SUPPORTED_ASPECTS.items():
        stretched = []
        for frame in frames:
            height = round(640 / ratio)
            canvas = np.zeros((height, 640), np.uint8)
            spare = height - 360
            for roi in SCENE_ROIS.values():
                x, y, w, h = (v // 3 for v in roi["rect"])
                shift = {"top": 0, "center": spare // 2, "bottom": spare}[roi["anchor"]]
                canvas[y + shift:y + shift + h, x:x + w] = frame[y:y + h, x:x + w]
            stretched.append(frame if name == "16:9" else cv2.resize(canvas, SCENE_SIZE, interpolation=cv2.INTER_AREA))
        result = aspect.choose_layout(stretched)
        aspect_frames.append(dict(source_aspect=name, squash=result.layout.squash, found=result.found))
    game_cases = []
    for explicit in (None, "", "apex", " Valorant "):
        for tag in (None, "apex", "Valorant ", "csgo"):
            info = models.VideoInfo("x", 1, 1920, 1080, "h264", 0, 0, 0, game=tag)
            game_cases.append(dict(explicit=explicit, tag=tag, expected=games.resolve_game(explicit, info)))
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "空白 名稱.mp4"
        cmd = [ffbin.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=1",
               "-c:v", "libopenh264", "-b:v", "40M", "-allow_skip_frames", "0", "-g", "60", "-pix_fmt", "yuv420p",
               "-metadata", "aditor_game_aspect=1920x1440", "-movflags", "+use_metadata_tags", str(path)]
        subprocess.run(cmd, check=True, capture_output=True)
        info = asdict(probe.probe(str(path)))
        for key in ("path", "size", "mtime"):
            info.pop(key)
        probe_doc = dict(info=info, keyframes=probe.keyframes(str(path)))
    write(OUT / "modules.json", dict(layout=layouts, profile=doc, games=game_cases, aspect_frames=aspect_frames,
          aspect=[dict(stats=list(s.items()), expected=aspect.pick_aspect(s)) for s in stats], probe=probe_doc))


def dump_phase_b():
    import importlib
    import inspect
    from aditor import autoclip, cache, derive, detect, events, icon_detect, mixtape

    p = profile.load_profile(ROOT / "templates/icons")
    cases = {"events": [], "derive": [], "autoclip": [], "detection": [], "merge": [], "clips_merge": [], "keywords": [], "control": [], "segments": {}, "cache_bytes": []}
    current = [""]

    class Tracker(events.EventTracker):
        def __init__(self, profile, **kw):
            super().__init__(profile, **kw)
            self.record = dict(test=current[0], resume_start=kw.get("resume_start"), frames=[], snapshots=[])

        def feed(self, t, r):
            frame = asdict(r)
            frame["name_sig"] = r.name_sig.to_b64() if r.name_sig is not None else None
            self.record["frames"].append([t, frame])
            super().feed(t, r)

        def snapshot(self):
            result = super().snapshot()
            self.record["snapshots"].append([len(self.record["frames"]), [[asdict(x) for x in a] for a in result]])
            return result

        def finish(self):
            result = super().finish()
            self.record["expected"] = [[asdict(x) for x in a] for a in result]
            cases["events"].append(self.record)
            return result

    def capture(fn, key, encode):
        def call(*a, **kw):
            result = fn(*a, **kw)
            cases[key].append(dict(test=current[0], **encode(a, kw), expected=[asdict(x) for x in result]))
            return result
        return call

    sys.path.insert(0, str(ROOT / "engine/tests"))
    for name in ("events", "derive", "autoclip"):
        module = importlib.import_module("test_" + name)
        if name == "events":
            module.EventTracker = Tracker
        elif name == "derive":
            module.derive = capture(derive.derive, name, lambda a, kw: dict(events=[asdict(e) for e in a[0]], spectating=[asdict(s) for s in a[1]]))
        else:
            module.auto_clips = capture(autoclip.auto_clips, name, lambda a, kw: dict(events=[asdict(e) for e in a[0]], params=asdict(a[1]), duration=a[2]))
        for test_name, fn in vars(module).items():
            if not test_name.startswith("test_") or not callable(fn):
                continue
            parameters = inspect.signature(fn).parameters
            if any(k != "profile" for k in parameters):
                continue
            current[0] = test_name
            fn(**({"profile": p} if "profile" in parameters else {}))

    cache_tests = importlib.import_module("test_cache")
    original_merge, original_clips = cache.merge_reanalysis, cache.merge_clips
    def merge(old, new):
        result = original_merge(old, new)
        cases["merge"].append(dict(old=[asdict(e) for e in old], new=[asdict(e) for e in new], expected=[[asdict(e) for e in part] for part in result]))
        return result
    def clips_merge(old, new):
        result = original_clips(old, new)
        cases["clips_merge"].append(dict(old=[asdict(c) for c in old], new=[asdict(c) for c in new], expected=[asdict(c) for c in result]))
        return result
    cache.merge_reanalysis, cache.merge_clips = merge, clips_merge
    try:
        for name, fn in vars(cache_tests).items():
            if name.startswith("test_merge"):
                fn()
    finally:
        cache.merge_reanalysis, cache.merge_clips = original_merge, original_clips
    for value in [dict(text="影片 中文\n\t\x01", floats=[1.0, -0.0, 1e-7, 1e16, 1e15, 0.9720723032951355]),
                  asdict(models.Event("a1000", 1., "knock", 0.9, True, None))]:
        cases["cache_bytes"].append(dict(value=value, expected=json.dumps(value, ensure_ascii=False)))

    det = detect.Detector(p)
    plain = mixtape.MixtapeDetector(p)
    paths = []
    for lang in ("en", "ja", "zh-TW"):
        folder = ROOT / "engine/tests/fixtures" / lang
        paths.extend(sorted(folder.glob("*/*.png")))
    paths.extend(sorted((ROOT / "engine/tests/fixtures/mixtape").glob("*_banner.png")))
    for path in paths:
        img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
        bh = p.banner_roi[3]
        if path.name.endswith("_banner.png"):
            banner = img
            spec_path = path.with_name(path.name.replace("_banner.png", "_spec.png"))
            if path.name == "self_banner.png":
                spec_path = path.with_name("assist_spec.png")
            spec = cv2.imdecode(np.fromfile(str(spec_path), np.uint8), cv2.IMREAD_COLOR)
        else:
            banner, spec = img[:bh], img[bh:, :p.spec_roi[2]]
        result = det.detect(banner, spec)
        frame = asdict(result)
        frame["name_sig"] = result.name_sig.to_b64() if result.name_sig is not None else None
        mix = plain.detect(banner, spec)
        if mix is not None:
            mix = {**asdict(mix), "name_sig": mix.name_sig.to_b64() if mix.name_sig else None}
        cases["detection"].append(dict(file=path.relative_to(ROOT / "engine/tests/fixtures").as_posix(), expected=frame,
                                        icon=det.icons.features(banner).to_dict(), mixtape=mix))
    from aditor import calibrate, control_feed
    for lang in ("en", "ja", "zh-TW"):
        labels = json.loads((ROOT / "engine/tests/fixtures" / lang / "labels.json").read_text(encoding="utf-8"))
        collector = calibrate.AnchorCollector(p, det)
        anchors = []
        for name, label in labels.items():
            if label["kind"] in ("knock", "assist_elim") and not label.get("fadein"):
                path = ROOT / "engine/tests/fixtures" / lang / ("pos" if label["kind"] != "none" else "neg") / name
                img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
                t = len(anchors) * 10.0
                collector.feed(t, img[:p.banner_roi[3]])
                anchors.append(path.relative_to(ROOT / "engine/tests/fixtures").as_posix())
        kw = calibrate.build_keywords([collector])
        cases["keywords"].append(dict(lang=lang, anchors=anchors, expected=kw.to_dict()))
        learned = detect.Detector(p, keywords=kw)
        for case in cases["detection"]:
            if not case["file"].startswith(lang + "/"):
                continue
            img = cv2.imdecode(np.fromfile(str(ROOT / "engine/tests/fixtures" / case["file"]), np.uint8), cv2.IMREAD_COLOR)
            r = learned.detect(img[:p.banner_roi[3]], img[p.banner_roi[3]:, :p.spec_roi[2]])
            case["learned"] = {**asdict(r), "name_sig": r.name_sig.to_b64() if r.name_sig else None}
    for feed_path in sorted((ROOT / "engine/tests/fixtures/control_feed").glob("*_feed.png")):
        spec_path = feed_path.with_name(feed_path.name.replace("_feed", "_spec"))
        feed_img = cv2.imdecode(np.fromfile(str(feed_path), np.uint8), cv2.IMREAD_COLOR)
        spec_img = cv2.imdecode(np.fromfile(str(spec_path), np.uint8), cv2.IMREAD_COLOR)
        detector = control_feed.ControlFeed(p)
        for t in (0., 0.25):
            detector.feed(t, feed_img, spec_img)
        cases["control"].append(dict(file=feed_path.name, active=detector.active, events=[e.to_dict() for e in detector.events]))
    ownership = importlib.import_module("test_segment_ownership")
    script = ownership._build_script()
    tracker = events.EventTracker(p)
    frames = []
    for i in range(240):
        r = script.get(i, models.FrameResult(None, 0., 0, False, None, False))
        tracker.feed(i * 0.25, r)
        frames.append([i * 0.25, {**asdict(r), "name_sig": r.name_sig.to_b64() if r.name_sig else None}])
    raw, spec = tracker.finish()
    cases["segments"] = dict(frames=frames, expected=[e.to_dict() for e in derive.derive(raw, spec, p)])
    transitions = json.loads((ROOT / "engine/tests/fixtures/mixtape/transitions.json").read_text(encoding="utf-8"))
    for name, frames in transitions.items():
        tracker = events.EventTracker(p)
        for t, r in frames:
            tracker.feed(t, models.FrameResult(**{**r, "name_sig": models.NameSig.from_b64(r["name_sig"]) if r["name_sig"] else None}))
        raw, spec = tracker.finish()
        cases["events"].append(dict(test="mixtape_" + name, resume_start=None, frames=frames, snapshots=[], expected=[[asdict(e) for e in raw], [asdict(s) for s in spec]]))
    transition_dir = OUT / "mixtape"
    transition_dir.mkdir(exist_ok=True)
    transition_frames = []
    tracker = events.EventTracker(p)
    with np.load(ROOT / "engine/tests/fixtures/mixtape/english_transitions.npz") as frames:
        for i, (t, band, hud) in enumerate(zip(frames["t"], frames["banner"], frames["spec"])):
            img = np.zeros((298, 800, 3), np.uint8)
            img[65:95, 180:620] = band
            img[192:220, 112:360] = hud
            path = transition_dir / f"transition-{i:02}.png"
            cv2.imencode(".png", img)[1].tofile(str(path))
            tracker.feed(float(t), det.detect(img[:180], img[180:, :480]))
            transition_frames.append([float(t), path.relative_to(OUT).as_posix()])
    raw, spec = tracker.finish()
    cases["mixtape_transitions"] = dict(frames=transition_frames, expected=[[asdict(e) for e in raw], [asdict(s) for s in spec]])
    write(OUT / "phase_b.json", cases)
    write(OUT / "phase_b_reference.json", dict(python=sys.version, opencv=cv2.__version__, numpy=np.__version__))
    print({k: len(v) for k, v in cases.items()})


def dump_analyze():
    from aditor.analyze import analyze
    from aditor.autoclip import auto_clips
    from aditor.derive import derive
    from aditor.ipc import Server
    import io

    media = OUT / "media"
    media.mkdir(exist_ok=True)
    p = profile.load_profile(ROOT / "templates/icons")
    banner = cv2.imdecode(np.fromfile(str(ROOT / "engine/tests/fixtures/en/pos/knock_a002500.png"), np.uint8), cv2.IMREAD_COLOR)[:180]
    cv2.imencode(".png", banner)[1].tofile(str(media / "banner.png"))
    video = media / "knocks.mp4"
    subprocess.run([ffbin.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=black:size=1920x1080:rate=4:duration=12", "-loop", "1", "-i", str(media / "banner.png"),
                    "-filter_complex", "[0:v][1:v]overlay=560:700:enable='between(t,1,3)+between(t,6,8)':shortest=1",
                    "-c:v", "libopenh264", "-b:v", "2M", "-g", "4", "-pix_fmt", "yuv420p",
                    "-metadata", "aditor_game=apex", "-metadata", "aditor_game_aspect=16:9",
                    "-movflags", "+use_metadata_tags", "-t", "12", str(video)], check=True)
    mix_video = media / "mixtape.mp4"
    mix_root = ROOT / "engine/tests/fixtures/mixtape"
    subprocess.run([ffbin.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=black:size=1920x1080:rate=4:duration=4", "-loop", "1", "-i", str(mix_root / "kill_banner.png"),
                    "-loop", "1", "-i", str(mix_root / "kill_spec.png"), "-filter_complex",
                    "[0:v][1:v]overlay=560:700:enable='between(t,0.5,2.5)':shortest=1[v];[v][2:v]overlay=60:950:shortest=1",
                    "-c:v", "libopenh264", "-b:v", "2M", "-g", "4", "-pix_fmt", "yuv420p",
                    "-metadata", "aditor_game=apex", "-metadata", "aditor_game_aspect=16:9", "-movflags", "+use_metadata_tags",
                    "-t", "4", str(mix_video)], check=True)

    def portable(doc):
        doc = json.loads(json.dumps(doc))
        # Only machine-specific paths and filesystem timestamps are removed.
        doc.pop("cache_path", None)
        if "video" in doc:
            doc["video"].pop("path", None)
            doc["video"].pop("mtime", None)
        return doc

    documents = []
    with tempfile.TemporaryDirectory(dir=ROOT / "engine/target") as tmp:
        for path in [video, mix_video, *sorted((ROOT / "engine/tests/fixtures/media").glob("*.mp4"))]:
            for jobs in (1, 2):
                doc = analyze(str(path), p, cache_dir=Path(tmp), force=True, jobs=jobs,
                              hwaccel=False, game="apex", layout=layout.parse_aspect("16:9"))
                events = [models.Event.from_dict(e) for e in doc["events"]]
                spec = [models.SpecInterval.from_dict(s) for s in doc["spectating"]]
                params = models.AutoClipParams(n=1)
                documents.append(dict(file=path.relative_to(ROOT / "engine").as_posix(), jobs=jobs,
                                      expected=portable(doc), derived=[e.to_dict() for e in derive(events, spec, p)],
                                      params=asdict(params), clips=[c.to_dict() for c in auto_clips(events, params, doc["video"]["duration"])]))

        requests = [dict(id="derive", cmd="derive", args=dict(events=documents[0]["expected"]["events"], spectating=[], profile_dir=str(p.dir))),
                    dict(id="autoclip", cmd="autoclip", args=dict(events=documents[0]["expected"]["events"], params=asdict(models.AutoClipParams()), duration=12)),
                    dict(id="cancel", cmd="cancel", args=dict(target="absent")),
                    dict(id="probe", cmd="probe", args=dict(path=str(video))),
                    dict(id="analyze", cmd="analyze", args=dict(path=str(video), profile_dir=str(p.dir), cache_dir=tmp,
                         hwaccel=False, game="apex", aspect="16:9", jobs=2, force=True))]
        output = io.BytesIO()
        server = Server([], output)
        server.serve()
        for request in requests:
            server._dispatch(json.dumps(request).encode())
            for thread in server._threads:
                thread.join()
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        # Progress emission frequency depends on wall-clock timing; assert the final sample separately in Rust.
        responses = [r for r in responses if r["type"] != "progress"]
        for response in responses:
            if response.get("id") == "analyze":
                response["data"] = portable(response["data"])
            if response.get("id") == "probe":
                response["data"].pop("path", None)
                response["data"].pop("mtime", None)
        for request in requests:
            for key, token in (("profile_dir", "@profile"), ("cache_dir", "@cache"), ("path", "@video")):
                if key in request["args"]:
                    request["args"][key] = token
        write(OUT / "analyze.json", dict(documents=documents, ipc=dict(requests=requests, responses=responses)))


if __name__ == "__main__" and "--phase-c-audit" in sys.argv:
    from parity_phase_c import audit
    audit()
elif __name__ == "__main__" and "--phase-c-benchmark" in sys.argv:
    from parity_phase_c import benchmark
    benchmark()
elif __name__ == "__main__" and "--phase-c" in sys.argv:
    from parity_phase_c import dump
    dump()
elif __name__ == "__main__" and "--analyze" in sys.argv:
    dump_analyze()
elif __name__ == "__main__" and "--phase-b" in sys.argv:
    dump_phase_b()
elif __name__ == "__main__":
    dump_cv()
    dump_modules()
    write(OUT / "reference.json", dict(python=sys.version, opencv=cv2.__version__, numpy=np.__version__))
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    phase_a = sum(p.stat().st_size for p in (OUT / "cv").rglob("*") if p.is_file()) + sum((OUT / name).stat().st_size for name in ("modules.json", "reference.json"))
    assert phase_a < 5_000_000 and total - phase_a < 5_000_000, total
    print(f"Wrote {OUT}: {total} bytes")
