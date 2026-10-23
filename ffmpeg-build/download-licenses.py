"""Collect the remaining dependencies' licenses from their exact source commits."""
import json
import re
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "aditor/ffmpeg-components.json").read_text(encoding="utf-8"))
sources = [
    ("amf", "GPUOpen-LibrariesAndSDKs/AMF", "LICENSE.txt"),
    ("dav1d", "videolan/dav1d", "COPYING"),
    ("onevpl", "intel/libvpl", "LICENSE"),
    ("openh264", "cisco/openh264", "LICENSE"),
    ("zlib", "madler/zlib", "zlib.h"),
]
output = root / "aditor/third-party-licenses"
output.mkdir(exist_ok=True)
records = []
for name, repository, license_file in sources:
    recipe = next((root / "scripts.d").glob(f"*-{name}.sh"))
    commit = re.search(r'SCRIPT_COMMIT="([0-9a-f]{40})"', recipe.read_text())[1]
    url = f"https://raw.githubusercontent.com/{repository}/{commit}/{license_file}"
    data = urllib.request.urlopen(url, timeout=60).read()
    (output / f"{name}-{Path(license_file).name}.txt").write_bytes(data)
    records.append({"name": name, "repository": f"https://github.com/{repository}", "commit": commit, "license": url})
name = "nv-codec-headers"
commit = manifest["upstream"]["nvCodecHeadersCommit"]
url = f"https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/{commit}/include/ffnvcodec/nvEncodeAPI.h"
(output / f"{name}-nvEncodeAPI.h.txt").write_bytes(urllib.request.urlopen(url, timeout=60).read())
records.append({"name": name, "repository": "https://github.com/FFmpeg/nv-codec-headers", "commit": commit, "license": url})
(output / "sources.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
