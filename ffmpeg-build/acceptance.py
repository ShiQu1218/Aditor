"""Exercise import formats through the real engine, thumbnail and software proxy paths.

Fixture creation may use a developer FFmpeg with additional encoders. Every operation
under test uses --ffmpeg. Fixtures and JSON evidence stay in the ignored build folder.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))


def run(binary, arguments):
    result = subprocess.run([str(binary), "-hide_banner", "-v", "error", "-nostdin", "-y", *arguments], capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace")[-4000:])
    return result


def main(args):
    from aditor.decode import FrameStream, GPU_CODECS
    from aditor.profile import load_profile
    profile = load_profile(ROOT / "templates/icons")
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ["ADITOR_FFMPEG"] = str(args.ffmpeg.resolve())
    cases = [
        ("h264-mp4", "mp4", "h264", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "aac"]),
        ("hevc-8", "mp4", "hevc", ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=2"], ["-c:a", "aac"]),
        ("hevc-main10-hdr", "mp4", "hevc", ["-pix_fmt", "yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=2", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"], ["-c:a", "aac"]),
        ("av1-8", "mp4", "av1", ["-c:v", "libsvtav1", "-preset", "12", "-svtav1-params", "lp=2"], ["-c:a", "aac"]),
        ("av1-10", "mp4", "av1", ["-pix_fmt", "yuv420p10le", "-c:v", "libsvtav1", "-preset", "12", "-svtav1-params", "lp=2"], ["-c:a", "aac"]),
        ("vp9-opus", "webm", "vp9", ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"], ["-c:a", "libopus"]),
        ("vp8-vorbis", "webm", "vp8", ["-c:v", "libvpx", "-deadline", "realtime"], ["-c:a", "libvorbis"]),
        ("obs-mkv", "mkv", "h264", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "aac"]),
        ("mov-pcm", "mov", "h264", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "pcm_s24le"]),
        ("m4v-aac", "m4v", "h264", ["-c:v", "libx264", "-preset", "ultrafast", "-f", "mp4"], ["-c:a", "aac"]),
        ("avi-mpeg4-mp3", "avi", "mpeg4", ["-c:v", "mpeg4"], ["-c:a", "libmp3lame"]),
        ("avi-mjpeg-pcm", "avi", "mjpeg", ["-c:v", "mjpeg", "-pix_fmt", "yuvj420p"], ["-c:a", "pcm_s16le"]),
        ("mkv-flac", "mkv", "h264", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "flac"]),
        ("mkv-ac3", "mkv", "h264", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "ac3"]),
    ]
    evidence = {"ffmpeg": str(args.ffmpeg), "fixtureFfmpeg": str(args.fixture_ffmpeg), "cases": [], "performance": {}}
    failed = False
    for name, extension, codec, video, audio in cases:
        source = args.output / f"{name}.{extension}"
        record = {"name": name, "codec": codec, "paths": {}}
        try:
            if not source.exists():
                run(args.fixture_ffmpeg, ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2", *video, *audio, "-shortest", str(source)])
            for hardware in (False, True):
                if hardware and codec not in GPU_CODECS:
                    record["paths"]["d3d11va"] = {"status": "unavailable", "reason": "The engine has no explicit D3D11VA surface path for this codec; auto decoding cannot prove hardware use"}
                    continue
                stream = FrameStream(str(source), profile, hwaccel=hardware, codec=codec)
                frames = list(stream)
                if len(frames) != 8:
                    raise AssertionError(f"Expected 8 engine samples, got {len(frames)}")
                record["paths"]["d3d11va" if hardware else "software"] = {
                    "status": "pass" if not hardware or stream.used_hwaccel else "unavailable",
                    "frames": len(frames),
                    "reason": "" if not hardware or stream.used_hwaccel else "Hardware path fell back to software; no GPU success claimed",
                }
            run(args.ffmpeg, ["-i", str(source), "-frames:v", "1", "-vf", "scale=320:180:force_original_aspect_ratio=decrease", str(args.output / f"{name}.jpg")])
            run(args.ffmpeg, ["-i", str(source), "-vf", "scale=320:180", "-c:v", "libopenh264", "-b:v", "2M", "-allow_skip_frames", "0", "-c:a", "aac", str(args.output / f"{name}-proxy.mp4")])
            record["paths"]["thumbnail-and-proxy"] = {"status": "pass"}
            record["status"] = "pass"
        except Exception as error:
            record.update(status="fail", error=str(error))
            failed = True
        evidence["cases"].append(record)
        print(f"{name}: {record['status']}", flush=True)

    if args.baseline_ffmpeg:
        source = args.benchmark_video.resolve() if args.benchmark_video else args.output / "benchmark.mp4"
        if args.benchmark_video and not source.is_file():
            raise FileNotFoundError(f"Benchmark video must be an existing file: {source}")
        if not source.exists():
            run(args.fixture_ffmpeg, ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=8", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-c:a", "aac", "-shortest", str(source)])
        binaries = {"baseline": args.baseline_ffmpeg, "minimal": args.ffmpeg}
        expected_frames = None
        evidence["benchmarkVideo"] = str(source)
        for operation in ("engine-software", "engine-analyze", "export-openh264"):
            samples = {name: [] for name in binaries}
            # Warm both binaries before alternating the measured order.
            for repeat in range(args.repeats + 1):
                order = list(binaries) if repeat % 2 else list(reversed(binaries))
                for name in order:
                    binary = binaries[name]
                    start = time.perf_counter()
                    if operation == "engine-software":
                        os.environ["ADITOR_FFMPEG"] = str(binary.resolve())
                        count = sum(1 for _ in FrameStream(str(source), profile, hwaccel=False, codec="h264"))
                        if not count:
                            raise AssertionError("Benchmark produced no engine samples")
                        if expected_frames is None:
                            expected_frames = count
                        if count != expected_frames:
                            raise AssertionError(f"Benchmark expected {expected_frames} engine samples, got {count}")
                    elif operation == "engine-analyze":
                        environment = dict(os.environ, ADITOR_FFMPEG=str(binary.resolve()))
                        environment.pop("ADITOR_FFPROBE", None)
                        result = subprocess.run([
                            sys.executable, "-m", "aditor", "analyze", str(source.resolve()),
                            "--profile-dir", str(ROOT / "templates/icons"),
                            "--cache-dir", str(args.output / f"benchmark-{name}-cache"),
                            "--force", "--no-hwaccel", "--jobs", "1", "--game", "apex", "--aspect", "16:9",
                        ], env=environment, cwd=ROOT / "engine", capture_output=True)
                        if result.returncode:
                            raise RuntimeError(result.stderr.decode(errors="replace")[-4000:])
                    else:
                        run(binary, ["-i", str(source), "-vf", "scale=1280:720", "-c:v", "libopenh264", "-b:v", "8M", "-allow_skip_frames", "0", "-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(args.output / f"benchmark-{name}-export.mp4")])
                    elapsed = time.perf_counter() - start
                    if repeat:
                        samples[name].append(elapsed)
            delta = statistics.median(samples["minimal"]) / statistics.median(samples["baseline"]) - 1
            evidence["performance"][operation] = {"seconds": samples, "regressionPercent": delta * 100, "status": "pass" if delta <= 0.05 else "fail"}
            failed |= delta > 0.05
            print(f"{operation}: {delta * 100:+.2f}%", flush=True)
    (args.output / "results.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return int(failed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--fixture-ffmpeg", type=Path, required=True)
    parser.add_argument("--baseline-ffmpeg", type=Path)
    parser.add_argument("--benchmark-video", type=Path, help="Optional existing video for the performance comparison (read-only)")
    parser.add_argument("--output", type=Path, default=ROOT / "build/ffmpeg-acceptance")
    parser.add_argument("--repeats", type=int, default=5)
    raise SystemExit(main(parser.parse_args()))
