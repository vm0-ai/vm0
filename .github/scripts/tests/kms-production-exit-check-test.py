#!/usr/bin/env python3
"""Exercise the actual CLI, files and child-process boundaries without live access."""

import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "kms-production-exit-check.py"
SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
SECRET = "must-not-leak-secret"


def envelope(key, direct=False):
    kms = {"keyId": key, "ciphertext": base64.b64encode(SECRET.encode()).decode()}
    if not direct:
        kms.update(
            {
                "encryptedDataKey": "eA==",
                "iv": "AAAAAAAAAAAAAAAA",
                "authTag": "AAAAAAAAAAAAAAAAAAAAAA==",
            }
        )
    body = json.dumps({"v": 1, "kind": "stored-secret", "kms": kms}).encode()
    return "vm0secret:v1:" + base64.urlsafe_b64encode(body).decode().rstrip("=")


class ExitCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = os.environ.copy()
        self.env.update(
            {
                "RUNNER_TEMP": str(self.root),
                "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
                "GITHUB_REPOSITORY": "vm0-ai/vm0",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "1234",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/vm0/.github/workflows/kms-production-exit-check.yml@refs/heads/main",
                "NEON_PROJECT_ID": "hidden-lab-39609750",
                "NEON_API_KEY": SECRET,
                "MIGRATION_VERIFIED_AT": (
                    dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
                )
                .isoformat()
                .replace("+00:00", "Z"),
                "AWS_METAL_RUNNER_USER": "ubuntu",
                "AWS_METAL_RUNNER_HOSTS": "a.vm3.ai,b.vm3.ai",
            }
        )
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env["PATH"] = str(self.bin) + os.pathsep + self.env["PATH"]

    def run_script(self, *args):
        result = subprocess.run(
            ["python3", str(SCRIPT), *args],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=15,
        )
        for value in (
            result.stdout,
            result.stderr,
            *(p.read_text() for p in self.root.glob("kms-exit-*.json")),
            *(p.read_text() for p in self.root.glob("summary.md")),
        ):
            self.assertNotIn(SECRET, value)
        return result

    def tool(self, name, content):
        path = self.bin / name
        path.write_text("#!/usr/bin/env python3\n" + content)
        path.chmod(0o755)

    def fake_neon(self):
        self.env["REQUEST_LOG"] = str(self.root / "requests.jsonl")
        self.tool(
            "curl",
            """import json,os,sys,urllib.parse
url=sys.argv[-1]
assert url.startswith("https://console.neon.tech/api/v2/projects/hidden-lab-39609750")
assert not any(arg in sys.argv for arg in ["-L", "--location", "--data", "-X", "--request"])
with open(os.environ["REQUEST_LOG"],"a") as f: f.write(json.dumps(url)+"\\n")
path=urllib.parse.urlsplit(url).path
if path.endswith("/branches"):
    if "cursor=page2" in url:
        data={"branches":[{"id":"br-other","name":"other"}]}
    else:
        data={"branches":[{"id":"br-prod","name":"production"}],"pagination":{"cursor":"page2"}}
elif path.endswith("/snapshots"):
    if os.environ.get("FAIL_SNAPSHOTS"):
        print(json.dumps({"message":"must-not-leak-secret"})+"\\n403", end="")
        sys.stderr.write("must-not-leak-secret")
        sys.exit(0)
    data={"snapshots":[{"id":"old","created_at":"2025-01-01T00:00:00Z"},{"id":"new-historical-lsn","created_at":"2099-01-01T00:00:00Z"}]}
elif path.endswith("/backup_schedule"):
    data={"schedule":[{"frequency":"daily","hour":3,"retention_seconds":604800}]}
else:
    data={"project":{"id":"hidden-lab-39609750","history_retention_seconds":int(os.environ.get("RETENTION","604800")),"unrelated_secret":"must-not-leak-secret"}}
print(json.dumps(data)+"\\n200", end="")
""",
        )

    def test_registry_inventory_counts_source_and_unknown_without_exposing_or_writing(
        self,
    ):
        runners = self.root / "runners"
        release = runners / "v1.2.3"
        release.mkdir(parents=True)
        values = [
            envelope(SOURCE),
            envelope(TARGET),
            envelope(SOURCE, direct=True),
            envelope("alias/unknown"),
            "malformed",
            None,
        ]
        data = {
            "sandboxes": {
                str(i): {"encryptedSecrets": value, "sandboxToken": SECRET}
                for i, value in enumerate(values)
            }
        }
        path = release / "proxy-registry.json"
        path.write_text(json.dumps(data))
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        staging = runners / "staging"
        staging.mkdir()
        (staging / "proxy-registry.json").write_text(SECRET)
        result = self.run_script("runner-local", str(runners))
        self.assertEqual(result.returncode, 0, result.stderr)
        counts = json.loads(result.stdout)
        self.assertEqual(
            {
                k: counts[k]
                for k in [
                    "source",
                    "target",
                    "unknownKey",
                    "invalid",
                    "noSecret",
                    "entries",
                ]
            },
            {
                "source": 2,
                "target": 1,
                "unknownKey": 1,
                "invalid": 1,
                "noSecret": 1,
                "entries": 6,
            },
        )
        self.assertEqual(counts["productionDirectories"], 1)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

    def test_missing_and_symlink_registries_are_unreadable(self):
        runners = self.root / "runners"
        for version in ["v1.2.3", "v1.2.4"]:
            (runners / version).mkdir(parents=True)
        outside = self.root / "outside.json"
        outside.write_text('{"sandboxes": {}}')
        (runners / "v1.2.4" / "proxy-registry.json").symlink_to(outside)
        result = self.run_script("runner-local", str(runners))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["unreadable"], 2)

    def test_duplicate_registry_keys_cannot_silently_hide_source_values(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "proxy-registry.json").write_text(
            '{"sandboxes": {"x": {}}, "sandboxes": {}}'
        )
        result = self.run_script("runner-local", str(release.parent))
        self.assertEqual(json.loads(result.stdout)["unreadable"], 1)

    def test_paginated_metadata_keeps_all_snapshots_for_review(self):
        self.fake_neon()
        result = self.run_script("backups")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertFalse(report["retirementCleared"])
        inventory = report["inventory"]
        self.assertTrue(inventory["configuredHistoryWindowOverlapsMigration"])
        self.assertEqual(inventory["otherBranchesNotInspected"], 1)
        self.assertEqual(inventory["retainedSnapshotsRequiringKeyReview"], 2)
        self.assertFalse(inventory["databaseConnected"])
        self.assertNotIn("connection_uri", (self.root / "requests.jsonl").read_text())

    def test_zero_history_window_does_not_clear_retained_snapshots(self):
        self.fake_neon()
        self.env["RETENTION"] = "0"
        self.assertEqual(self.run_script("backups").returncode, 0)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertFalse(
            report["inventory"]["configuredHistoryWindowOverlapsMigration"]
        )
        self.assertEqual(report["inventory"]["retainedSnapshotsRequiringKeyReview"], 2)
        self.assertFalse(report["retirementCleared"])

    def test_provider_failure_is_incomplete_and_sanitized(self):
        self.fake_neon()
        self.env["FAIL_SNAPSHOTS"] = "1"
        self.assertEqual(self.run_script("backups").returncode, 1)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertEqual(report["result"], "incomplete")
        self.assertEqual(report["failure"], "neon_metadata_request_failed")

    def test_nonproduction_context_never_contacts_neon(self):
        self.fake_neon()
        self.env["GITHUB_REF"] = "refs/heads/feature"
        self.assertEqual(self.run_script("backups").returncode, 1)
        self.assertFalse((self.root / "requests.jsonl").exists())

    def test_unexpected_remote_fields_are_never_exported(self):
        self.tool(
            "ssh",
            'import sys\nsys.stdin.read()\nprint(\'{"secret":"must-not-leak-secret"}\')\n',
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertEqual(report["inventory"]["hostsExpected"], 2)
        self.assertFalse(report["inventory"]["collectionComplete"])

    def test_partial_fleet_failure_preserves_observed_source_dependency(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "proxy-registry.json").write_text(
            json.dumps({"sandboxes": {"x": {"encryptedSecrets": envelope(SOURCE)}}})
        )
        local = self.run_script("runner-local", str(release.parent))
        fixture = self.root / "host-report.json"
        fixture.write_text(local.stdout)
        self.env["HOST_REPORT_FIXTURE"] = str(fixture)
        self.tool(
            "ssh",
            """import os,sys
sys.stdin.read()
if "ubuntu@b.vm3.ai" in sys.argv:
    sys.stderr.write("must-not-leak-secret")
    sys.exit(1)
print(open(os.environ["HOST_REPORT_FIXTURE"]).read())
""",
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertEqual(report["inventory"]["totals"]["source"], 1)
        self.assertFalse(report["inventory"]["collectionComplete"])
        self.assertFalse(report["retirementCleared"])


if __name__ == "__main__":
    unittest.main()
