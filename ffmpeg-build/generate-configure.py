"""Generate FFmpeg flags exclusively from the reviewed component manifest."""
import argparse
import json
import re
from pathlib import Path

CATEGORIES = {
    "encoders": "encoder", "decoders": "decoder", "hwaccels": "hwaccel",
    "muxers": "muxer", "demuxers": "demuxer", "filters": "filter",
    "indevs": "indev", "protocols": "protocol", "parsers": "parser",
}


def generate(manifest):
    if manifest["schemaVersion"] != 1:
        raise ValueError("Unsupported FFmpeg manifest schema")
    for key in ("commit", "ffmpegCommit", "nvCodecHeadersCommit"):
        if not re.fullmatch(r"[0-9a-f]{40}", manifest["upstream"][key]):
            raise ValueError(f"Expected full source commit: {key}")
    flags = list(manifest["configure"])
    for category, switch in CATEGORIES.items():
        names = [name for group in manifest["components"][category] for name in group.get("configureNames", group["names"])]
        if len(set(names)) != len(names) or not names:
            raise ValueError(f"Empty or duplicate {category}")
        if any(not re.fullmatch(r"[a-z0-9_]+", name) for name in names):
            raise ValueError(f"Invalid {category} name")
        flags.append(f"--enable-{switch}={','.join(names)}")
    if any(not re.fullmatch(r"--[a-z0-9_=,.-]+", flag) for flag in flags):
        raise ValueError("Unsafe configure argument")
    if any(flag.startswith(("--enable-gpl", "--enable-nonfree")) for flag in flags):
        raise ValueError("Aditor requires LGPL FFmpeg")
    return flags


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    print("\n".join(generate(json.loads(args.manifest.read_text(encoding="utf-8")))))
