from pathlib import Path
import subprocess
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import extract_templates as templates


def test_dump_works_without_a_png_encoder_and_preserves_pixels_times_and_empty_ranges(tmp_path):
    source = tmp_path / "source.png"
    color = np.full((36, 64, 3), (12, 37, 201), dtype=np.uint8)
    templates.imwrite(source, color)
    video = tmp_path / "source.mkv"
    subprocess.run([templates.ffmpeg(), "-v", "error", "-y", "-loop", "1", "-framerate", "4",
                    "-i", str(source), "-t", "0.5", "-c:v", "ffv1", "-threads", "1", "-pix_fmt", "bgr0", str(video)], check=True)
    out = tmp_path / "擷取 空白"
    assert templates.dump(video, 0, 0.5, 4, (560, 700, 800, 180), out, "40:10") == 2
    files = sorted(out.glob("*.png"))
    assert [f.name for f in files] == ["t00000.00.png", "t00000.25.png"]
    for file in files:
        image = templates.imread(file)
        assert image.shape == (10, 40, 3)
        assert np.all(image == color[0, 0])
    assert not list(out.glob("aditor_dump_*"))
    empty = tmp_path / "empty"
    assert templates.dump(video, 2, 3, 4, None, empty) == 0
    assert list(empty.iterdir()) == []
