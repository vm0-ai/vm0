#!/usr/bin/env python3
"""Assemble the pinned macOS runtime from verified upstream bytes, never npm install."""

import argparse
import hashlib
import json
import platform
import shutil
import struct
import subprocess
import tarfile
import tempfile
from urllib.parse import urljoin, urlsplit
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch_archive(url):
    # curl verifies TLS using the macOS/system trust store. Restrict its protocol
    # explicitly and handle redirects here rather than enabling --location.
    # Validate each redirect as well as the manifest URL, including its authority.
    authorities = {"github.com", "release-assets.githubusercontent.com", "registry.npmjs.org"}
    for _ in range(6):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc not in authorities:
            raise ValueError("CUA download URL must use an official HTTPS host")
        with tempfile.TemporaryDirectory(prefix="cua-download-") as temporary:
            archive = Path(temporary) / "archive"
            response = subprocess.run([
                "curl", "--silent", "--show-error", "--proto", "=https",
                "--max-time", "60", "--output", str(archive),
                "--write-out", "%{json}", url,
            ], capture_output=True, text=True)
            if response.returncode != 0:
                raise ValueError("CUA HTTPS download failed")
            metadata = json.loads(response.stdout)
            if metadata["http_code"] in {301, 302, 303, 307, 308}:
                location = metadata["redirect_url"]
                if not location:
                    raise ValueError("CUA download redirect has no location")
                url = urljoin(url, location)
                continue
            if metadata["http_code"] != 200:
                raise ValueError(f"CUA download failed: HTTP {metadata['http_code']}")
            return archive.read_bytes()
    raise ValueError("CUA download exceeded the redirect limit")


def download(artifact, cache):
    cached = cache / artifact["sha256"]
    if cached.exists():
        data = cached.read_bytes()
    else:
        data = fetch_archive(artifact["url"])
    if digest(data) != artifact["sha256"]:
        raise ValueError(f"CUA integrity mismatch: {artifact['id']}")
    # A cache hit is verified just like a fresh download. Never cache extracted code.
    cached.write_bytes(data)
    return cached


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"Unsafe CUA archive path: {name}")
    return path


def extract(artifact, archive, output):
    destination = output / safe_path(artifact["destination"])
    with tarfile.open(archive, "r:gz") as source:
        members = {}
        # Validate the entire archive before writing even the selected files.
        for member in source:
            safe_path(member.name)
            if not (member.isfile() or member.isdir()) or member.name in members:
                raise ValueError(f"Unsafe CUA archive entry: {member.name}")
            members[member.name] = member
        for name in artifact["files"]:
            member = members[name]
            if not member.isfile():
                raise ValueError(f"Missing CUA file: {name}")
            relative = safe_path(name)
            if "package" in artifact:
                if relative.parts[0] != "package":
                    raise ValueError(f"Invalid npm archive root: {name}")
                relative = PurePosixPath(*relative.parts[1:])
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as content:
                target.write_bytes(content.read())
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    if "package" in artifact:
        package = json.loads((destination / "package.json").read_text())
        if (package["name"], package["version"]) != (
            artifact["package"], artifact["version"]
        ):
            raise ValueError(f"CUA package/version mismatch: {artifact['id']}")


def verify_arm64(path):
    data = path.read_bytes()
    magic = data[:4]
    if magic == b"\xcf\xfa\xed\xfe":
        architectures = [struct.unpack_from("<I", data, 4)[0]]
    elif magic == b"\xca\xfe\xba\xbe":
        count = struct.unpack_from(">I", data, 4)[0]
        architectures = [struct.unpack_from(">I", data, 8 + n * 20)[0] for n in range(count)]
    else:
        raise ValueError(f"CUA payload is not Mach-O: {path.name}")
    if 0x0100000C not in architectures:
        raise ValueError(f"CUA payload lacks arm64: {path.name}")


def stage(manifest_path, output, cache):
    manifest = json.loads(manifest_path.read_text())
    if manifest["target"] != "darwin-arm64":
        raise ValueError("CUA distribution supports only darwin-arm64")
    cache.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cua-stage-", dir=output.parent) as temporary:
        staged = Path(temporary) / "cua"
        staged.mkdir()
        for artifact in manifest["artifacts"]:
            extract(artifact, download(artifact, cache), staged)
        for name in manifest["nativeCode"]:
            verify_arm64(staged / safe_path(name))
            (staged / name).chmod(0o755)
        licenses = staged / "licenses"
        licenses.mkdir()
        for source in manifest_path.parent.glob("*.txt"):
            shutil.copyfile(source, licenses / source.name)
        shutil.copyfile(manifest_path, staged / "artifacts.json")
        files = {}
        for item in sorted(staged.rglob("*")):
            if item.is_symlink():
                raise ValueError("CUA staging must not contain symlinks")
            if item.is_file():
                files[item.relative_to(staged).as_posix()] = digest(item.read_bytes())
        (staged / "payload.json").write_text(json.dumps({
            "driverVersion": manifest["driverVersion"],
            "files": files,
        }, indent=2) + "\n")
        # Only replace a prior output after the complete new payload has passed.
        if output.exists():
            shutil.rmtree(output)
        shutil.move(str(staged), output)
    print(f"CUA {manifest['driverVersion']} staged: {len(files)} files; upstream SHA-256 verified")


def verify_payload(root, signed, manifest_path):
    manifest = json.loads((root / "artifacts.json").read_text())
    if manifest != json.loads(manifest_path.read_text()):
        raise ValueError("CUA packaged manifest does not match the source lock")
    payload = json.loads((root / "payload.json").read_text())
    if payload["driverVersion"] != manifest["driverVersion"]:
        raise ValueError("CUA payload version mismatch")
    actual = {}
    for item in root.rglob("*"):
        if item.is_symlink():
            raise ValueError("CUA packaged payload contains a symlink")
        if item.is_file() and item.name != "payload.json":
            actual[item.relative_to(root).as_posix()] = digest(item.read_bytes())
    if actual.keys() != payload["files"].keys():
        raise ValueError("CUA packaged file inventory mismatch")
    for name, expected in payload["files"].items():
        if signed and name in manifest["nativeCode"]:
            continue
        if actual[name] != expected:
            raise ValueError(f"CUA packaged integrity mismatch: {name}")
    for name in manifest["nativeCode"]:
        verify_arm64(root / safe_path(name))
        if not (root / name).stat().st_mode & 0o111:
            raise ValueError(f"CUA native executable bit missing: {name}")
    print(f"CUA {manifest['driverVersion']} package inventory/architecture verified (signed={signed})")


def main():
    desktop = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=desktop / "cua/artifacts.json")
    parser.add_argument("--out", type=Path, default=desktop / "native/dist/cua")
    parser.add_argument("--cache", type=Path, default=desktop / ".cache/cua")
    parser.add_argument("--target", choices=["darwin-arm64"])
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--signed", action="store_true")
    args = parser.parse_args()
    if args.verify:
        verify_payload(args.verify, args.signed, args.manifest)
        return
    if args.target is None and platform.system() != "Darwin":
        print("CUA distribution is macOS-only; no runtime staged on this platform")
        return
    if args.target is None and platform.machine() != "arm64":
        raise ValueError("CUA distribution supports only darwin-arm64")
    stage(args.manifest, args.out, args.cache)


if __name__ == "__main__":
    main()
