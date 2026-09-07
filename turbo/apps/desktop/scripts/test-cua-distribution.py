"""Exercise the distribution CLI against real archives/filesystem, without a native SDK mock."""

import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("stage-cua-runtime.py")


class DistributionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "input.tgz"
        self.output = self.root / "output"
        self.cache = self.root / "cache"
        self.manifest_path = self.root / "artifacts.json"

    def prepare(self, architecture=b"\x0c\x00\x00\x01", extra=None, version="0.23.2"):
        files = {
            "package/package.json": json.dumps({"name": "@trycua/cua-driver", "version": version}).encode(),
            "package/cua-driver": b"\xcf\xfa\xed\xfe" + architecture + bytes(24),
            "package/index.js": b"export const version = '0.23.2';",
        }
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        self.manifest = {
            "driverVersion": "0.23.2", "target": "darwin-arm64",
            "nativeCode": ["cua-driver"],
            "artifacts": [{
                "id": "fixture", "url": self.archive.as_uri(),
                "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                "destination": ".", "files": list(files),
                "package": "@trycua/cua-driver", "version": "0.23.2",
            }],
        }
        self.manifest_path.write_text(json.dumps(self.manifest))

    def run_stage(self):
        return subprocess.run([sys.executable, str(SCRIPT), "--target", "darwin-arm64",
            "--manifest", str(self.manifest_path), "--out", str(self.output),
            "--cache", str(self.cache)], capture_output=True, text=True)

    def verify(self, signed=False):
        return subprocess.run([sys.executable, str(SCRIPT), "--verify", str(self.output),
            *(["--signed"] if signed else [])], capture_output=True, text=True)

    def test_clean_stage_cache_and_signature_domains(self):
        self.prepare()
        result = self.run_stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.verify().returncode, 0)
        self.archive.unlink()  # A verified archive cache is sufficient to rebuild.
        self.assertEqual(self.run_stage().returncode, 0)
        binary = self.output / "cua-driver"
        binary.write_bytes(binary.read_bytes() + b"new-code-signature")
        self.assertNotEqual(self.verify().returncode, 0)
        self.assertEqual(self.verify(signed=True).returncode, 0)
        (self.output / "index.js").write_text("corrupt")
        self.assertNotEqual(self.verify(signed=True).returncode, 0)

    def test_corrupt_download_and_cache_fail_before_extraction(self):
        self.prepare()
        self.assertEqual(self.run_stage().returncode, 0)
        expected = (self.output / "payload.json").read_bytes()
        cached = self.cache / self.manifest["artifacts"][0]["sha256"]
        cached.write_bytes(b"corrupt")
        result = self.run_stage()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("integrity mismatch", result.stderr)
        self.assertEqual((self.output / "payload.json").read_bytes(), expected)
        cached.unlink()
        self.archive.write_bytes(b"corrupt download")
        self.assertNotEqual(self.run_stage().returncode, 0)

    def test_wrong_version_and_architecture_fail(self):
        for options in [{"version": "0.23.1"}, {"architecture": b"\x07\x00\x00\x01"}]:
            with self.subTest(options=options):
                self.prepare(**options)
                self.assertNotEqual(self.run_stage().returncode, 0)
                self.assertFalse(self.output.exists())

    def test_links_and_traversal_are_rejected_before_any_output(self):
        for name, kind in [("../../outside", tarfile.REGTYPE), ("package/link", tarfile.SYMTYPE), ("package/hardlink", tarfile.LNKTYPE), ("/absolute", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = "../../outside"
                self.prepare(extra=entry)
                self.assertNotEqual(self.run_stage().returncode, 0)
                self.assertFalse(self.output.exists())

    def test_missing_selected_resource_and_packaged_symlink_fail(self):
        self.prepare()
        self.manifest["artifacts"][0]["files"].append("package/missing")
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.prepare()
        self.assertEqual(self.run_stage().returncode, 0)
        (self.output / "index.js").unlink()
        (self.output / "index.js").symlink_to(self.manifest_path)
        self.assertNotEqual(self.verify(signed=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
