"""Exercise the distribution CLI against real archives/filesystem, without a native SDK mock."""

import hashlib
import io
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("stage-cua-runtime.py")

# Replace only the external curl executable in a fresh CLI process. Archive
# verification, extraction, cache writes, and output publication stay real.
HTTPS_FIXTURE = """
import json, os, sys
from pathlib import Path
assert sys.argv[sys.argv.index('--proto') + 1] == '=https'
assert '--insecure' not in sys.argv and '-k' not in sys.argv
assert '--location' not in sys.argv
Path(sys.argv[sys.argv.index('--output') + 1]).write_bytes(Path(os.environ['CUA_TEST_DOWNLOAD']).read_bytes())
redirect = os.environ.get('CUA_TEST_REDIRECT', '')
print(json.dumps({'http_code': 302 if redirect else 200, 'redirect_url': redirect}))
"""


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
            "sourceCommit": "e88e9d899ac5effaeae38619527ebaa46b26ce72",
            "nativeCode": ["cua-driver"],
            "artifacts": [{
                "id": "fixture", "url": "https://github.com/trycua/cua/releases/download/test/input.tgz",
                "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                "destination": ".", "files": list(files),
                "package": "@trycua/cua-driver", "version": "0.23.2",
            }],
        }
        self.manifest_path.write_text(json.dumps(self.manifest))
        # Fixture bytes enter through the real content-addressed archive cache.
        self.cache.mkdir(exist_ok=True)
        (self.cache / self.manifest["artifacts"][0]["sha256"]).write_bytes(self.archive.read_bytes())

    def run_stage(self, fixture_transport=False, redirect=None):
        environment = dict(os.environ)
        if fixture_transport:
            binary = self.root / "bin/curl"
            binary.parent.mkdir(exist_ok=True)
            binary.write_text(f"#!{sys.executable}\n" + HTTPS_FIXTURE)
            binary.chmod(0o755)
            environment["PATH"] = str(binary.parent) + os.pathsep + environment["PATH"]
            environment["CUA_TEST_DOWNLOAD"] = str(self.archive)
            if redirect is not None:
                environment["CUA_TEST_REDIRECT"] = redirect
        return subprocess.run([sys.executable, str(SCRIPT), "--target", "darwin-arm64",
            "--manifest", str(self.manifest_path), "--out", str(self.output),
            "--cache", str(self.cache)], capture_output=True, text=True, env=environment)

    def verify(self, signed=False):
        return subprocess.run([sys.executable, str(SCRIPT), "--verify", str(self.output),
            "--manifest", str(self.manifest_path),
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
        result = self.run_stage(fixture_transport=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("integrity mismatch", result.stderr)
        self.assertFalse(cached.exists())
        self.assertEqual((self.output / "payload.json").read_bytes(), expected)

    def test_download_rejects_local_insecure_and_untrusted_urls(self):
        for url in [self.archive.as_uri(), "http://github.com/input.tgz", "https://untrusted.invalid/input.tgz"]:
            with self.subTest(url=url):
                self.prepare()
                artifact = self.manifest["artifacts"][0]
                (self.cache / artifact["sha256"]).unlink()
                artifact["url"] = url
                self.manifest_path.write_text(json.dumps(self.manifest))
                result = self.run_stage()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("official HTTPS host", result.stderr)
                self.assertFalse(self.output.exists())

    def test_download_rejects_local_insecure_and_untrusted_redirects(self):
        for url in [self.archive.as_uri(), "http://github.com/input.tgz", "https://untrusted.invalid/input.tgz"]:
            with self.subTest(url=url):
                self.prepare()
                (self.cache / self.manifest["artifacts"][0]["sha256"]).unlink()
                result = self.run_stage(fixture_transport=True, redirect=url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("official HTTPS host", result.stderr)
                self.assertFalse(self.output.exists())

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

    def test_packaged_lock_inventory_and_version_are_checked_against_source(self):
        self.prepare()
        for fault in ["missing", "extra", "version", "lock"]:
            with self.subTest(fault=fault):
                self.assertEqual(self.run_stage().returncode, 0)
                if fault == "missing":
                    (self.output / "index.js").unlink()
                elif fault == "extra":
                    (self.output / "extra.js").write_text("unexpected code")
                elif fault == "version":
                    payload = json.loads((self.output / "payload.json").read_text())
                    payload["driverVersion"] = "0.23.1"
                    (self.output / "payload.json").write_text(json.dumps(payload))
                else:
                    lock = json.loads((self.output / "artifacts.json").read_text())
                    lock["nativeCode"].append("index.js")
                    (self.output / "artifacts.json").write_text(json.dumps(lock))
                self.assertNotEqual(self.verify(signed=True).returncode, 0)

    def prepare_inspection(self):
        self.prepare()
        self.assertEqual(self.run_stage().returncode, 0)
        desktop = self.root / "desktop"
        (desktop / "scripts").mkdir(parents=True)
        (desktop / "cua").mkdir()
        for name in ["inspect-cua-package.py", "stage-cua-runtime.py"]:
            shutil.copyfile(SCRIPT.parent / name, desktop / "scripts" / name)
        shutil.copyfile(self.manifest_path, desktop / "cua/artifacts.json")
        package = {"version": "0.48.0", "devDependencies": {"electron": "42.5.1"}}
        (desktop / "package.json").write_text(json.dumps(package))
        subprocess.run(["git", "init", "-q", str(desktop)], check=True)
        subprocess.run(["git", "-C", str(desktop), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                        "commit", "-q", "--allow-empty", "-m", "test: package fixture"], check=True)
        app = self.root / "Okou.app"
        resources = app / "Contents/Resources"
        shutil.copytree(self.output, resources / "cua")
        payload_path = resources / "cua/payload.json"
        payload = json.loads(payload_path.read_text())
        for name in ["cua-driver", "cua-driver-darwin-arm64"]:
            relative = f"node_modules/@trycua/{name}/package.json"
            target = resources / "cua" / relative
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"version": "0.23.2"}))
            payload["files"][relative] = hashlib.sha256(target.read_bytes()).hexdigest()
        payload_path.write_text(json.dumps(payload))
        (resources / "app/dist").mkdir(parents=True)
        (resources / "app/package.json").write_text(json.dumps(package))
        for name in ["main.js", "bootstrap.js", "preload.js"]:
            (resources / "app/dist" / name).write_text("fixture bundle")
        (app / "Contents/MacOS").mkdir()
        executable = app / "Contents/MacOS/Okou"
        executable.write_text(f"#!/bin/sh\ntouch '{self.root}/launched'\n")
        executable.chmod(0o755)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleShortVersionString": "0.48.0", "CFBundleDisplayName": "Okou",
            "CFBundleIdentifier": "ai.okou.desktop", "CFBundleExecutable": "Okou",
            "LSMinimumSystemVersion": "14.0",
        }))
        framework = app / "Contents/Frameworks/Electron Framework.framework/Resources"
        framework.mkdir(parents=True)
        (framework / "Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": "42.5.1"}))
        (resources / "bundle-link").symlink_to("app/dist/main.js")
        archive = self.root / "candidate.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for item in app.rglob("*"):
                if item.is_symlink():
                    entry = zipfile.ZipInfo(item.relative_to(self.root).as_posix())
                    entry.create_system = 3
                    entry.external_attr = 0o120777 << 16
                    output.writestr(entry, os.readlink(item))
                elif item.is_file():
                    output.write(item, item.relative_to(self.root))
        binary = self.root / "bin"
        binary.mkdir()
        for name in ["codesign", "lipo", "spctl", "xcrun"]:
            executable = binary / name
            executable.write_text(f"#!{sys.executable}\n" + """
import os, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
if tool == 'codesign':
    if os.environ.get('CUA_TEST_INVALID_SIGNATURE'): sys.exit(1)
    if '--requirements' in sys.argv:
        print('designated => identifier "ai.okou.desktop"' if os.environ.get('CUA_TEST_EXPLICIT_REQUIREMENT') else '# designated => cdhash H"abc"')
    elif '--display' in sys.argv: print('Identifier=ai.okou.desktop\\nTeamIdentifier=not set\\nSignature=adhoc\\nCDHash=abc', file=sys.stderr)
elif tool == 'lipo': print('arm64')
else: sys.exit(1)
""")
            executable.chmod(0o755)
        return desktop, app, archive, binary

    def test_inspection_binds_archive_bytes_and_observes_signatures_without_launch(self):
        desktop, app, archive, binary = self.prepare_inspection()
        environment = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        args = [sys.executable, str(desktop / "scripts/inspect-cua-package.py"),
                "--app", str(app), "--archive", str(archive)]
        before = {item: item.read_bytes() for item in app.rglob("*") if item.is_file()}
        result = subprocess.run(args, env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["signature"]["kind"], "ad-hoc")
        self.assertTrue(report["signature"]["designatedRequirementImplicit"])
        self.assertEqual(report["signature"]["designatedRequirement"], 'cdhash H"abc"')
        self.assertEqual(report["gatekeeperAssessment"], "not-accepted")
        self.assertEqual(report["stapling"], "not-validated")
        self.assertTrue(report["archive"]["matchesInspectedApp"])
        self.assertEqual(report["archive"]["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertNotIn(str(self.root), result.stdout)
        explicit = subprocess.run(args, env={**environment, "CUA_TEST_EXPLICIT_REQUIREMENT": "1"},
                                  capture_output=True, text=True)
        self.assertEqual(explicit.returncode, 0, explicit.stderr)
        self.assertFalse(json.loads(explicit.stdout)["signature"]["designatedRequirementImplicit"])
        with zipfile.ZipFile(archive, "a") as output:
            output.writestr("Okou.app/Contents/unexpected", "tampered")
        result = subprocess.run(args, env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive_inventory_mismatch", result.stderr)
        environment["CUA_TEST_INVALID_SIGNATURE"] = "1"
        result = subprocess.run(args, env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("code_signature_invalid", result.stderr)
        self.assertFalse((self.root / "launched").exists())
        self.assertEqual(before, {item: item.read_bytes() for item in app.rglob("*") if item.is_file()})


if __name__ == "__main__":
    unittest.main()
