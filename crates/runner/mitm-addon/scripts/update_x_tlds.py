"""Update the generated IANA TLD data used by X billing URL detection."""

from __future__ import annotations

import argparse
import difflib
import importlib.util
import re
import ssl
import sys
import tempfile
import urllib.error
import urllib.request
from http import HTTPStatus
from pathlib import Path
from types import ModuleType
from typing import NamedTuple

SOURCE_HOST = "data.iana.org"
SOURCE_PATH = "/TLD/tlds-alpha-by-domain.txt"
SOURCE_URL = f"https://{SOURCE_HOST}{SOURCE_PATH}"
FETCH_TIMEOUT_SECONDS = 30
ADDON_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ADDON_ROOT / "src/usage/providers/connectors/x_tlds.py"
VERSION_RE = re.compile(r"^# Version (?P<version>\d+), Last Updated (?P<timestamp>.+)$")
TLD_RE = re.compile(r"^[a-z0-9-]+$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SnapshotComparison(NamedTuple):
    checked_version: str
    source_version: str
    checked_count: int
    source_count: int
    added: tuple[str, ...]
    removed: tuple[str, ...]

    @property
    def has_set_drift(self) -> bool:
        return bool(self.added or self.removed)

    @property
    def has_version_drift(self) -> bool:
        return self.checked_version != self.source_version


def fetch_source() -> str:
    # S310 (suspicious-url-open-usage): SOURCE_URL is a fixed https:// IANA
    # endpoint, not user input. The opener below uses the default CA-verifying
    # SSL context and disables redirects so the fixed host cannot drift.
    request = urllib.request.Request(  # noqa: S310
        SOURCE_URL,
        headers={"User-Agent": "vm0-mitm-addon-tld-updater"},
        method="GET",
    )
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _NoRedirect,
    )
    try:
        with opener.open(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            if response.status != HTTPStatus.OK:
                raise RuntimeError(f"failed to fetch {SOURCE_URL}: HTTP {response.status}")
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        with exc:
            raise RuntimeError(f"failed to fetch {SOURCE_URL}: HTTP {exc.code}") from exc


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


def compare_snapshot_to_source(source: str) -> SnapshotComparison:
    checked_version, checked_tlds = read_existing_snapshot()
    source_version, source_tlds = parse_source(source)
    checked_set = set(checked_tlds)
    source_set = set(source_tlds)
    return SnapshotComparison(
        checked_version=checked_version,
        source_version=source_version,
        checked_count=len(checked_tlds),
        source_count=len(source_tlds),
        added=tuple(sorted(source_set - checked_set)),
        removed=tuple(sorted(checked_set - source_set)),
    )


def check_source(source_file: Path) -> int:
    comparison = compare_snapshot_to_source(source_file.read_text(encoding="utf-8"))
    sys.stdout.write(
        f"checked-in IANA TLD version {comparison.checked_version} "
        f"({comparison.checked_count} TLDs)\n"
    )
    sys.stdout.write(
        f"source IANA TLD version {comparison.source_version} ({comparison.source_count} TLDs)\n"
    )
    if comparison.has_set_drift:
        sys.stderr.write("IANA TLD set drift detected\n")
        if comparison.added:
            sys.stderr.write(f"added: {', '.join(comparison.added)}\n")
        if comparison.removed:
            sys.stderr.write(f"removed: {', '.join(comparison.removed)}\n")
        return 1

    if comparison.has_version_drift:
        sys.stdout.write("IANA TLD version differs, but the TLD set is unchanged\n")
    else:
        sys.stdout.write("IANA TLD version and TLD set match supplied source\n")
    return 0


def write_generated_module(contents: str) -> None:
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            dir=OUTPUT_PATH.parent,
            prefix=f".{OUTPUT_PATH.name}.",
            suffix=".tmp",
            delete=False,
            encoding="utf-8",
        ) as tmp_file:
            tmp_path = Path(tmp_file.name)
            tmp_file.write(contents)
        tmp_path.replace(OUTPUT_PATH)
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()


def update_generated(source_file: Path | None) -> int:
    source = source_file.read_text(encoding="utf-8") if source_file is not None else fetch_source()
    version, tlds = parse_source(source)
    write_generated_module(render_module(version, tlds))
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
        "--check-source",
        action="store_true",
        help="compare the checked-in TLD set against --source-file without updating",
    )
    parser.add_argument(
        "--source-file",
        type=Path,
        help="read an IANA tlds-alpha-by-domain.txt file instead of fetching the live source",
    )
    args = parser.parse_args()

    if args.check and args.check_source:
        parser.error("--check cannot be combined with --check-source")
    if args.check:
        if args.source_file is not None:
            parser.error("--check cannot be combined with --source-file")
        return check_generated()
    if args.check_source:
        if args.source_file is None:
            parser.error("--check-source requires --source-file")
        return check_source(args.source_file)
    return update_generated(args.source_file)
