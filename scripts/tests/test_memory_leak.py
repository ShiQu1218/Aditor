"""Regression fixtures for the PowerShell memory trend screening script.

Run: python -m unittest discover -s scripts/tests -p test_memory_leak.py
"""

import csv
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "test-memory-leak.ps1"
SHELLS = [path for name in ("powershell", "pwsh") if (path := shutil.which(name))]


@unittest.skipUnless(SHELLS, "PowerShell is required")
class MemoryTrendTests(unittest.TestCase):
    def run_fixture(self, rows, expected, fields=None):
        for shell in SHELLS:
            with self.subTest(shell=shell), tempfile.TemporaryDirectory() as folder:
                path = Path(folder)
                with (path / "processes.csv").open("w", newline="", encoding="utf-8") as stream:
                    writer = csv.DictWriter(
                        stream,
                        fieldnames=fields or ["ElapsedSeconds", "PrivateMiB", "ProcessId", "Name", "ProcessStartedAt"],
                    )
                    writer.writeheader()
                    writer.writerows(rows)
                original = (path / "processes.csv").read_bytes()
                result = subprocess.run(
                    [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT), "-InputDir", folder],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
                )
                reports = list(path.glob("memory-leak-*.json"))
                self.assertEqual((path / "processes.csv").read_bytes(), original)
                if expected is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(reports, [])
                    continue
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(len(reports), 1)
                report = json.loads(reports[0].read_text(encoding="utf-8-sig"))
                self.assertEqual(report["Status"], expected)
                self.assertTrue(report["Processes"])
                if expected == "SuspectedLeak":
                    suspects = [p for p in report["Processes"] if p["Status"] == "SuspectedLeak"]
                    self.assertGreaterEqual(suspects[0]["SlopeMiBPerMinute"], 1)
                    self.assertGreaterEqual(suspects[0]["GrowthMiB"], 32)

    @staticmethod
    def samples(memory, duration=31 * 60, started="2026-10-20T00:00:00Z"):
        return [
            {"ElapsedSeconds": t, "PrivateMiB": memory(t / 60), "ProcessId": 123,
             "Name": "aditorrec.exe", "ProcessStartedAt": started}
            for t in range(0, duration + 1, 5)
        ]

    def test_sustained_growth(self):
        self.run_fixture(self.samples(lambda minute: 400 + 2 * minute), "SuspectedLeak")

    def test_stable_memory(self):
        self.run_fixture(self.samples(lambda minute: 400), "NoSustainedGrowthDetected")

    def test_warmup_only_growth(self):
        self.run_fixture(self.samples(lambda minute: 400 + min(minute, 5) * 20), "NoSustainedGrowthDetected")

    def test_growth_then_plateau(self):
        self.run_fixture(self.samples(lambda minute: 400 + min(minute, 15) * 10), "NoSustainedGrowthDetected")

    def test_repeated_reclamation(self):
        self.run_fixture(self.samples(lambda minute: 400 + (minute % 5) * 10), "NoSustainedGrowthDetected")

    def test_brief_spike(self):
        self.run_fixture(self.samples(lambda minute: 900 if 20 < minute < 20.2 else 400), "NoSustainedGrowthDetected")

    def test_short_session(self):
        self.run_fixture(self.samples(lambda minute: 400 + minute * 10, duration=9 * 60), "InsufficientData")

    def test_reused_pid_is_not_one_lifetime(self):
        rows = self.samples(lambda minute: 400 + minute * 10, duration=15 * 60)
        later = self.samples(lambda minute: 400 + minute * 10, duration=15 * 60, started="2026-10-20T00:16:00Z")
        for row in later:
            row["ElapsedSeconds"] += 16 * 60
        self.run_fixture(rows + later, "InsufficientData")

    def test_sampling_gap_splits_segments(self):
        rows = self.samples(lambda minute: 400 + minute * 10, duration=40 * 60)
        rows = [r for r in rows if r["ElapsedSeconds"] <= 15 * 60 or r["ElapsedSeconds"] >= 25 * 60]
        self.run_fixture(rows, "InsufficientData")

    def test_legacy_csv(self):
        rows = self.samples(lambda minute: 400)
        for row in rows:
            del row["ProcessStartedAt"]
        self.run_fixture(rows, "NoSustainedGrowthDetected", fields=["ElapsedSeconds", "PrivateMiB", "ProcessId", "Name"])

    def test_malformed_memory_is_rejected(self):
        rows = self.samples(lambda minute: 400)
        rows[0]["PrivateMiB"] = "NaN"
        self.run_fixture(rows, None)

    def test_duplicate_timestamp_is_rejected(self):
        rows = self.samples(lambda minute: 400)
        self.run_fixture(rows + [rows[0]], None)

    def test_empty_csv_is_rejected(self):
        self.run_fixture([], None)


if __name__ == "__main__":
    unittest.main()
