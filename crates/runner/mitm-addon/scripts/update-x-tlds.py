#!/usr/bin/env python3
"""Update the generated IANA TLD data used by X billing URL detection."""

from __future__ import annotations

import argparse
import difflib
import http.client
import importlib.util
import re
import sys
from http import HTTPStatus
from pathlib import Path
from types import ModuleType

SOURCE_HOST = "data.iana.org"
SOURCE_PATH = "/TLD/tlds-alpha-by-domain.txt"
SOURCE_URL = f"https://{SOURCE_HOST}{SOURCE_PATH}"
FETCH_TIMEOUT_SECONDS = 30
ADDON_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ADDON_ROOT / "src/usage/providers/connectors/x_tlds.py"
VERSION_RE = re.compile(r"^# Version (?P<version>\d+), Last Updated (?P<timestamp>.+)$")
TLD_RE = re.compile(r"^[a-z0-9-]+$")


def fetch_source() -> str:
    connection = http.client.HTTPSConnection(SOURCE_HOST, timeout=FETCH_TIMEOUT_SECONDS)
    try:
        connection.request("GET", SOURCE_PATH, headers={"User-Agent": "vm0-mitm-addon-tld-updater"})
        response = connection.getresponse()
        if response.status != HTTPStatus.OK:
            raise RuntimeError(f"failed to fetch {SOURCE_URL}: HTTP {response.status}")
        return response.read().decode("utf-8")
    finally:
        connection.close()


def parse_source(source: str) -> tuple[str, tuple[str, ...]]:
    lines = source.splitlines()
    if not lines:
        raise ValueError("IANA TLD source is empty")

    version_match = VERSION_RE.match(lines[0])
    if version_match is None:
        raise ValueError("IANA TLD source is missing the version header")
    version = version_match.group("version")

    tlds: set[str] = set()
    for line in lines[1:]:
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        tld = raw.lower()
        try:
            tld.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError(f"IANA TLD is not ASCII: {raw}") from exc
        if TLD_RE.fullmatch(tld) is None or tld.startswith("-") or tld.endswith("-"):
            raise ValueError(f"IANA TLD has invalid syntax: {raw}")
        tlds.add(tld)

    if not tlds:
        raise ValueError("IANA TLD source contains no TLD entries")

    return version, tuple(sorted(tlds))


def render_module(version: str, tlds: tuple[str, ...]) -> str:
    lines = [
        '"""Generated IANA top-level-domain data for X tweet URL billing.',
        "",
        "Source: https://data.iana.org/TLD/tlds-alpha-by-domain.txt",
        "Update with: crates/runner/mitm-addon/scripts/update-x-tlds.py",
        "",
        "Do not hand-edit. Runtime code uses this checked-in snapshot so",
        "billing never depends on live network access inside the sandbox.",
        '"""',
        "",
        f'IANA_TLD_VERSION = "{version}"',
        "",
        "IANA_TLDS = frozenset(",
        "    {",
    ]
    lines.extend(f'        "{tld}",' for tld in tlds)
    lines.extend(
        [
            "    }",
            ")",
            "",
        ]
    )
    return "\n".join(lines)


def load_generated_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("x_tlds_generated", OUTPUT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load module spec for {OUTPUT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_existing_snapshot() -> tuple[str, tuple[str, ...]]:
    module = load_generated_module()
    version = getattr(module, "IANA_TLD_VERSION", None)
    tlds = getattr(module, "IANA_TLDS", None)
    if not isinstance(version, str) or not version:
        raise ValueError("generated module has invalid IANA_TLD_VERSION")
    if not isinstance(tlds, frozenset) or not all(isinstance(tld, str) for tld in tlds):
        raise ValueError("generated module has invalid IANA_TLDS")
    return version, tuple(sorted(tlds))


def check_generated() -> int:
    version, tlds = read_existing_snapshot()
    expected = render_module(version, tlds)
    actual = OUTPUT_PATH.read_text(encoding="utf-8")
    if actual == expected:
        sys.stdout.write(f"{OUTPUT_PATH} is canonical for IANA TLD version {version}\n")
        return 0

    sys.stderr.write(f"{OUTPUT_PATH} is not canonical\n")
    diff = difflib.unified_diff(
        actual.splitlines(keepends=True),
        expected.splitlines(keepends=True),
        fromfile=str(OUTPUT_PATH),
        tofile=f"{OUTPUT_PATH} (expected)",
    )
    sys.stderr.writelines(diff)
    return 1


def update_generated(source_file: Path | None) -> int:
    source = source_file.read_text(encoding="utf-8") if source_file is not None else fetch_source()
    version, tlds = parse_source(source)
    OUTPUT_PATH.write_text(render_module(version, tlds), encoding="utf-8")
    sys.stdout.write(f"wrote {OUTPUT_PATH} with {len(tlds)} TLDs from IANA version {version}\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the checked-in generated module is canonical without network access",
    )
    parser.add_argument(
        "--source-file",
        type=Path,
        help="read an IANA tlds-alpha-by-domain.txt file instead of fetching the live source",
    )
    args = parser.parse_args()

    if args.check:
        if args.source_file is not None:
            parser.error("--check cannot be combined with --source-file")
        return check_generated()
    return update_generated(args.source_file)


if __name__ == "__main__":
    sys.exit(main())
