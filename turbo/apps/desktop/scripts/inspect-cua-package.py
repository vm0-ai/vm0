"""Read-only CUA package inspection. Never launches, signs, grants, or edits an app."""

import argparse
import hashlib
import json
import os
import plistlib
import stat
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

DESKTOP = Path(__file__).resolve().parent.parent


class InspectionError(Exception):
    """A bounded diagnostic produced only by this inspector."""


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=60)


def signing(path):
    verified = command(["codesign", "--verify", "--deep", "--strict", str(path)])
    if verified.returncode:
        raise InspectionError("code_signature_invalid")
    details = command(["codesign", "--display", "--verbose=4", str(path)])
    requirement = command(["codesign", "--display", "--requirements", "-", str(path)])
    if details.returncode or requirement.returncode:
        raise InspectionError("code_signature_unreadable")
    fields = {}
    authorities = []
    for line in details.stderr.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ["Identifier", "TeamIdentifier", "CDHash", "Signature"]:
            fields[key] = value
        if separator and key == "Authority":
            authorities.append(value)
    # codesign prefixes an implicitly synthesized requirement with "# ".
    # Preserve that distinction; an ad-hoc cdhash requirement is not a Team ID.
    designated = [line for line in (requirement.stdout + requirement.stderr).splitlines()
                  if line.startswith(("designated => ", "# designated => "))]
    if not fields.get("Identifier") or len(designated) != 1:
        raise InspectionError("code_signature_identity_missing")
    return {
        "verified": True,
        "kind": "ad-hoc" if fields.get("Signature") == "adhoc" else "certificate",
        "identifier": fields["Identifier"],
        "team": fields.get("TeamIdentifier"),
        "authorities": authorities,
        "cdhash": fields.get("CDHash"),
        "designatedRequirement": designated[0].removeprefix("# ").removeprefix("designated => "),
        "designatedRequirementImplicit": designated[0].startswith("# "),
    }


def verify_archive(archive_path, app):
    """Bind the uploaded inner ZIP to the app inspected/probed on this runner."""
    expected = {item.relative_to(app).as_posix(): item for item in app.rglob("*")
                if item.is_symlink() or item.is_file()}
    seen = set()
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            is_link = stat.S_ISLNK(member.external_attr >> 16)
            if (member.is_dir() and not is_link) or member.filename.startswith("__MACOSX/"):
                continue
            if not member.filename.startswith(app.name + "/"):
                raise InspectionError("archive_app_identity_mismatch")
            name = member.filename[len(app.name) + 1:]
            if name not in expected or name in seen:
                raise InspectionError("archive_inventory_mismatch")
            item = expected[name]
            if is_link != item.is_symlink():
                raise InspectionError("archive_file_type_mismatch")
            if not is_link and (member.external_attr >> 16) & 0o111 != item.stat().st_mode & 0o111:
                raise InspectionError("archive_executable_mode_mismatch")
            with archive.open(member) as source:
                if is_link:
                    matches = source.read() == os.readlink(item).encode()
                else:
                    matches = hashlib.file_digest(source, "sha256").hexdigest() == sha256(item)
            if not matches:
                raise InspectionError("archive_bytes_mismatch")
            seen.add(name)
    if seen != expected.keys():
        raise InspectionError("archive_inventory_mismatch")
    return {"name": archive_path.name, "sha256": sha256(archive_path),
            "domain": "inner-app-zip", "matchesInspectedApp": True}


def inspect(app, archive):
    resources = app / "Contents/Resources"
    runtime = resources / "cua"
    lock = json.loads((DESKTOP / "cua/artifacts.json").read_text())
    package = json.loads((resources / "app/package.json").read_text())
    source_package = json.loads((DESKTOP / "package.json").read_text())
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    with (app / "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist").open("rb") as source:
        electron = plistlib.load(source)
    if info["CFBundleShortVersionString"] != package["version"] or package["version"] != source_package["version"]:
        raise InspectionError("desktop_version_mismatch")
    if electron["CFBundleVersion"] != source_package["devDependencies"]["electron"]:
        raise InspectionError("electron_version_mismatch")
    signature = signing(app)
    if signature["identifier"] != info["CFBundleIdentifier"]:
        raise InspectionError("bundle_signature_identity_mismatch")
    verified = command([sys.executable, str(DESKTOP / "scripts/stage-cua-runtime.py"),
                        "--verify", str(runtime), "--signed"])
    if verified.returncode:
        raise InspectionError("cua_payload_verification_failed")
    native = {name: {"sha256": sha256(runtime / name), "signature": signing(runtime / name)}
              for name in lock["nativeCode"]}
    architecture = command(["lipo", "-archs", str(app / "Contents/MacOS" / info["CFBundleExecutable"])])
    if architecture.returncode or architecture.stdout.strip() != "arm64":
        raise InspectionError("app_architecture_mismatch")
    assessment = command(["spctl", "--assess", "--type", "execute", str(app)])
    stapling = command(["xcrun", "stapler", "validate", str(app)])
    runtime_config = resources / "app/desktop-runtime-config.json"
    config = json.loads(runtime_config.read_text()) if runtime_config.exists() else None
    if config is not None and set(config) - {"product", "platformUrl"}:
        raise InspectionError("unexpected_runtime_config_fields")
    if config is not None:
        url = urlsplit(config["platformUrl"])
        if url.scheme not in ["http", "https"] or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise InspectionError("runtime_config_is_not_public_metadata")
    source = command(["git", "-C", str(DESKTOP), "rev-parse", "HEAD"])
    if source.returncode:
        raise InspectionError("inspection_checkout_unavailable")
    cua_packages = {name: json.loads((runtime / "node_modules/@trycua" / name / "package.json").read_text())["version"]
                    for name in ["cua-driver", "cua-driver-darwin-arm64"]}
    if any(version != lock["driverVersion"] for version in cua_packages.values()):
        raise InspectionError("cua_package_version_mismatch")
    report = {
        "schemaVersion": 1,
        "inspectionCheckout": source.stdout.strip(),
        "ci": {name: os.environ.get(name) for name in ["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_EVENT_NAME", "CUA_EVIDENCE_PR_HEAD"]},
        "desktopVersion": package["version"], "electronVersion": electron["CFBundleVersion"],
        "cuaVersion": lock["driverVersion"], "cuaSource": lock["sourceCommit"],
        "cuaPackages": cua_packages,
        "bundleId": info["CFBundleIdentifier"], "displayName": info["CFBundleDisplayName"],
        "minimumMacOS": info["LSMinimumSystemVersion"], "architecture": "arm64",
        "runtimeConfig": config, "signature": signature,
        "gatekeeperAssessment": "accepted" if assessment.returncode == 0 else "not-accepted",
        "stapling": "valid" if stapling.returncode == 0 else "not-validated",
        "nativePostSign": native,
        "stagedPayloadManifestSha256": sha256(runtime / "payload.json"),
        "upstreamArchives": {item["id"]: item["sha256"] for item in lock["artifacts"]},
        "bundles": {name: sha256(resources / "app/dist" / name) for name in ["bootstrap.js", "main.js", "preload.js"]},
        "archive": verify_archive(archive, app) if archive else None,
    }
    encoded = json.dumps(report, indent=2)
    if len(encoded) > 16384:
        raise InspectionError("package_metadata_exceeded_limit")
    return encoded


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--archive", type=Path, help="Optional inner app ZIP to compare byte-for-byte")
    args = parser.parse_args()
    try:
        print(inspect(args.app, args.archive))
    except InspectionError as error:
        print(f"Package inspection failed: {error}", file=sys.stderr)
        sys.exit(1)
    except (ValueError, TypeError, UnicodeError, OSError, KeyError, subprocess.SubprocessError, zipfile.BadZipFile):
        # Native-tool stderr may contain private paths; keep failed evidence bounded.
        print("Package inspection failed; no app was launched or modified.", file=sys.stderr)
        sys.exit(1)
