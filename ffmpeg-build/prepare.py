"""Apply the Aditor overlay to the pinned BtbN source checkout (build workspace only)."""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

from importlib.util import module_from_spec, spec_from_file_location

HERE = Path(__file__).resolve().parent
spec = spec_from_file_location("configure", HERE / "generate-configure.py")
configure = module_from_spec(spec)
spec.loader.exec_module(configure)


def prepare(root, manifest_path):
    root = root.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    subprocess.run(["git", "merge-base", "--is-ancestor", manifest["upstream"]["commit"], "HEAD"], cwd=root, check=True)
    flags = configure.generate(manifest)
    variant = root / "variants/win64-lgpl-shared-aditor.sh"
    variant.write_text(
        '#!/bin/bash\nsource "$(dirname "$BASH_SOURCE")/win64-lgpl-shared.sh"\n'
        + "FF_CONFIGURE='" + " ".join(flags) + "'\n"
        + "ADITOR_FFMPEG_COMMIT='" + manifest["upstream"]["ffmpegCommit"] + "'\n"
        + '''
package_variant() {
    local input="$1" output="$2"
    mkdir -p "$output"/{bin,lib,include,build-config}
    cp "$input"/bin/*.{exe,dll} "$output/bin/"
    cp "$input"/bin/*.lib "$output/lib/"
    cp "$input"/lib/*.{def,dll.a} "$output/lib/"
    cp -r "$input"/include/. "$output/include/"
    cp ffbuild/ffmpeg/config.h ffbuild/ffmpeg/config_components.h "$output/build-config/"
    cp aditor/configure.txt aditor/ffmpeg-components.json "$output/build-config/"
    cp aditor/verify-ffmpeg-components.ps1 "$output/build-config/"
    cp -r aditor "$output/build-config/recipe"
    git rev-parse HEAD > "$output/build-config/build-recipe-commit.txt"
    # Ship dependency license texts and original source coordinates with the zip.
    cp -r aditor/third-party-licenses "$output/"
}
''', encoding="utf-8", newline="\n")

    # Keep BtbN's dependency build machinery/toolchain but prune the graph AND
    # downloads. These are recipes, not addins (8.1 is the release-branch addin).
    keep = {
        "10-mingw.sh", "10-mingw-std-threads.sh", "10-xorg-macros.sh", "15-base.sh",
        "20-zlib.sh", "50-amf.sh", "50-dav1d.sh", "50-ffnvcodec.sh",
        "50-onevpl.sh", "50-openh264.sh", "zz-final.sh",
    }
    scripts = (root / "scripts.d").resolve()
    if not scripts.is_relative_to(root):
        raise ValueError("Dependency recipe directory escapes the upstream checkout")
    if not all((scripts / name).is_file() for name in keep):
        raise ValueError("Pinned upstream dependency recipes are missing")
    for path in scripts.iterdir():
        if path.name not in keep:
            if not path.resolve().is_relative_to(scripts):
                raise ValueError(f"Dependency recipe path escapes the build workspace: {path}")
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    (scripts / "zz-final.sh").write_text('''#!/bin/bash
SCRIPT_SKIP=1
ffbuild_depends() { printf '%s\\n' base zlib amf dav1d ffnvcodec onevpl openh264; }
ffbuild_enabled() { return 0; }
ffbuild_dockerfinal() { return 0; }
ffbuild_dockerdl() { return 0; }
ffbuild_dockerlayer() { return 0; }
ffbuild_dockerstage() { return 0; }
ffbuild_dockerbuild() { return 0; }
ffbuild_ldexeflags() { return 0; }
''', encoding="utf-8", newline="\n")
    # Preserve SDK 13.0 even if the upstream addin/version logic changes later.
    (scripts / "50-ffnvcodec.sh").write_text('''#!/bin/bash
SCRIPT_REPO="https://github.com/FFmpeg/nv-codec-headers.git"
SCRIPT_COMMIT="''' + manifest["upstream"]["nvCodecHeadersCommit"] + '''"
ffbuild_enabled() { return 0; }
ffbuild_dockerbuild() { make PREFIX="$FFBUILD_PREFIX" DESTDIR="$FFBUILD_DESTDIR" install; }
ffbuild_configure() { echo --enable-ffnvcodec; }
''', encoding="utf-8", newline="\n")

    build = root / "build.sh"
    text = build.read_text(encoding="utf-8")
    clone = "git clone --filter=blob:none --branch='$GIT_BRANCH' '$FFMPEG_REPO' ffmpeg"
    checkout = """git init ffmpeg
    git -C ffmpeg remote add origin '$FFMPEG_REPO'
    git -C ffmpeg fetch --depth=1 origin '$ADITOR_FFMPEG_COMMIT'
    git -C ffmpeg checkout --detach FETCH_HEAD"""
    if clone not in text and checkout not in text:
        raise ValueError("Upstream build.sh changed; review the pinned source checkout")
    text = text.replace(clone, checkout).replace("make install install-doc", "make install")
    build.write_text(text, encoding="utf-8", newline="\n")
    download = root / "download.sh"
    download_text = download.read_text(encoding="utf-8")
    if 'shopt -s nullglob\n' not in download_text:
        download_text = download_text.replace('set -xe\n', 'set -xe\nshopt -s nullglob\n')
    download.write_text(download_text, encoding="utf-8", newline="\n")
    aditor = root / "aditor"
    aditor.mkdir(exist_ok=True)
    if manifest_path.resolve() != (aditor / "ffmpeg-components.json").resolve():
        shutil.copyfile(manifest_path, aditor / "ffmpeg-components.json")
    (aditor / "configure.txt").write_text("\n".join(flags) + "\n", encoding="utf-8", newline="\n")
    print(f"Prepared {root}: win64 lgpl-shared-aditor 8.1")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("upstream", type=Path)
    parser.add_argument("--manifest", type=Path, default=HERE.parent / "scripts/ffmpeg-components.json")
    args = parser.parse_args()
    prepare(args.upstream, args.manifest)
