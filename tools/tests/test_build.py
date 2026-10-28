import os
from pathlib import Path
import shutil
import subprocess


def test_skip_engine_rejects_stale_binary_by_hash_even_with_equal_mtime(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    source = Path(__file__).resolve().parents[2] / "scripts/build.ps1"
    shutil.copyfile(source, scripts / "build.ps1")
    (scripts / "verify-live-engine.ps1").write_text("Write-Host 'compatibility checked'", encoding="utf-8")
    release = tmp_path / "engine/target/release/aditor.exe"
    staged = tmp_path / "build/engine/aditor/aditor.exe"
    for path, data in [(release, b"fresh"), (staged, b"stale")]:
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
        os.utime(path, (1000, 1000))
    args = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(scripts / "build.ps1"),
            "-SkipEngine", "-EngineOnly"]
    stale = subprocess.run(args, capture_output=True, timeout=30)
    assert stale.returncode != 0
    assert b"Staged engine does not match" in stale.stderr
    staged.write_bytes(release.read_bytes())
    os.utime(staged, (2000, 2000))
    fresh = subprocess.run(args, capture_output=True, timeout=30)
    assert fresh.returncode == 0, fresh.stderr
    assert b"compatibility checked" in fresh.stdout
