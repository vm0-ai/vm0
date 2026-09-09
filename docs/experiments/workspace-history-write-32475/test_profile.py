"""Exercise the experiment's CLI using real temporary evidence files."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("profile.py")


class ProfileCliTests(unittest.TestCase):
    def invoke(self, *arguments):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, arguments)],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )

    def parse(self, directory, details, chunks=1):
        result = {
            "iteration": 0,
            "chunks": chunks,
            "duration_ns": 1000,
            "success": True,
        }
        log = directory / "sample.log"
        log.write_text(
            "PROFILE_BEGIN iteration=0\n"
            + "".join(
                "PROFILE_DETAIL " + json.dumps(detail) + "\n" for detail in details
            )
            + "PROFILE_RESULT "
            + json.dumps(result)
            + "\nPROFILE_VERIFIED iteration=0\n"
        )
        return self.invoke("parse", log)

    def test_baseline_has_unknown_not_zero_stage_cost(self):
        with tempfile.TemporaryDirectory() as name:
            result = self.parse(Path(name), [])
            self.assertEqual(result.returncode, 0, result.stderr)
            sample = json.loads(result.stdout)[0]
            self.assertTrue(sample["verified"])
            self.assertIsNone(sample["timings_ns"])

    def test_overlapping_io_is_not_added_to_serial_residual(self):
        with tempfile.TemporaryDirectory() as name:
            result = self.parse(
                Path(name),
                [
                    {"phase": "host_path", "duration_ns": 100},
                    {
                        "phase": "host_chunk",
                        "seq": 7,
                        "duration_ns": 800,
                        "gate_ns": 10,
                    },
                    {
                        "phase": "host_frame",
                        "seq": 7,
                        "builder_wait_ns": 10,
                        "encode_ns": 20,
                        "write_with_lock_ns": 100,
                    },
                    {"phase": "host_reply", "seq": 7, "duration_ns": 600},
                    {"phase": "guest_begin", "seq": 7, "queue_and_copy_ns": 20},
                    {"phase": "guest_spawn", "duration_ns": 50},
                    {
                        "phase": "guest_wait",
                        "child_and_setup_ns": 300,
                        "stdin_join_ns": 10,
                        "stderr_drain_ns": 20,
                    },
                    {"phase": "guest_stdin", "duration_ns": 280},
                    {
                        "phase": "guest_io",
                        "open_ns": 30,
                        "copy_with_stdin_ns": 250,
                        "flush_ns": 1,
                    },
                    {"phase": "guest_handler", "seq": 7, "duration_ns": 400},
                ],
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            timings = json.loads(result.stdout)[0]["timings_ns"]
            self.assertEqual(timings["host_chunk_residual"], 60)
            self.assertEqual(timings["host_outer_residual"], 100)
            self.assertEqual(timings["guest_handler_residual"], 20)
            self.assertEqual(timings["guest_copy_stdin_overlap"], 250)
            self.assertIsNone(timings["host_publish"])

    def test_incomplete_chunk_capture_fails_instead_of_undercounting(self):
        with tempfile.TemporaryDirectory() as name:
            result = self.parse(
                Path(name),
                [
                    {
                        "phase": "host_chunk",
                        "seq": 7,
                        "duration_ns": 800,
                        "gate_ns": 10,
                    },
                ],
                chunks=2,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing chunk measurements", result.stderr)

    def test_failed_processes_and_missing_samples_stay_in_denominator(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            record = {
                "case": "small",
                "arm": "observed",
                "status": 0,
                "failure": "invalid capture",
                "expected_samples": 5,
                "samples": [],
            }
            (directory / "failed.json").write_text(json.dumps(record))
            (directory / "failed.log").write_text("incomplete evidence\n")
            result = self.invoke("analyze", directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["failed_processes"], 1)
            self.assertEqual(report["expected_samples"], 5)
            self.assertEqual(report["captured_samples"], 0)
            (directory / "unrecorded.log").write_text("orphaned log\n")
            result = self.invoke("analyze", directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("logs without process records", result.stderr)

    def test_percentiles_use_per_invocation_residuals(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            # Independent component percentiles cannot be subtracted: these
            # invocations have the same residual but different parent costs.
            samples = [
                {
                    "iteration": index + 1,
                    "duration_ns": outer,
                    "success": True,
                    "verified": True,
                    "timings_ns": {"host_outer_residual": 100},
                    "details": [],
                    "host_path_ns": [],
                    "publish_ns": [],
                }
                for index, outer in enumerate((500, 900, 600))
            ]
            (directory / "complete.json").write_text(
                json.dumps(
                    {
                        "case": "small",
                        "arm": "observed",
                        "status": 0,
                        "failure": None,
                        "expected_samples": 3,
                        "samples": samples,
                    }
                )
            )
            result = self.invoke("analyze", directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            group = json.loads(result.stdout)["groups"][0]
            self.assertEqual(group["ms"]["50"], 600 / 1e6)
            self.assertEqual(group["ms"]["99"], 900 / 1e6)
            self.assertEqual(
                group["phases"]["host_outer_residual"]["ms"]["99"], 100 / 1e6
            )
            compact = self.invoke("export", directory)
            self.assertEqual(compact.returncode, 0, compact.stderr)
            evidence = directory / "evidence.jsonl"
            evidence.write_text(compact.stdout)
            replay = self.invoke("analyze", evidence)
            self.assertEqual(replay.returncode, 0, replay.stderr)
            self.assertEqual(json.loads(replay.stdout), json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()
