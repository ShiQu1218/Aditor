"""Subprocess boundary shared by maintained evaluation tools."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def command(*args):
    return [os.environ.get("ADITOR_ENGINE") or str(ROOT / "engine/target/release/aditor.exe"),
            *map(str, args)]


def json_lines(*args):
    with subprocess.Popen(command(*args), stdout=subprocess.PIPE, text=True, encoding="utf-8") as child:
        try:
            for line in child.stdout:
                yield json.loads(line)
        except BaseException:
            if child.poll() is None:
                child.terminate()
            raise
        finally:
            child.stdout.close()
            code = child.wait()
        if code:
            raise subprocess.CalledProcessError(code, child.args)


def analyze(video, profile_dir, cache_dir, out, jobs=1):
    subprocess.run(command("analyze", video, "--profile-dir", profile_dir,
                           "--cache-dir", cache_dir, "--out", out, "--jobs", jobs, "--force"),
                   check=True)
    return json.loads(Path(out).read_text(encoding="utf-8"))
