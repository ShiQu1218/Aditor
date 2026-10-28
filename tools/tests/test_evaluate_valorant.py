import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

from evaluate_valorant import match_events  # noqa: E402


def test_matching_maximizes_pairs_before_minimizing_error():
    # Nearest-first would consume 10.4 for 10.5 and lose the first kill.
    result = match_events([10.0, 10.5], [10.4, 10.9], 0.5)
    assert (result["tp"], result["fp"], result["fn"]) == (2, 0, 0)


def test_duplicate_predictions_are_not_collapsed():
    result = match_events([10.0], [10.0, 10.0], 0.5)
    assert (result["tp"], result["fp"], result["fn"]) == (1, 1, 0)


def test_matching_keeps_real_timing_error_without_offset_correction():
    result = match_events([10.0], [10.8], 0.5)
    assert (result["tp"], result["fp"], result["fn"]) == (0, 1, 1)
