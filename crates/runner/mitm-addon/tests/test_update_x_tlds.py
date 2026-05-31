from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from scripts import update_x_tlds
from usage.providers.connectors.x_tlds import IANA_TLD_VERSION, IANA_TLDS

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_UPDATE_SCRIPT = _ADDON_ROOT / "scripts" / "update-x-tlds.py"
_CLI_TIMEOUT_SECONDS = 30


def test_parse_source_normalizes_sorts_and_deduplicates_tlds():
    version, tlds = update_x_tlds.parse_source(
        "# Version 2026010100, Last Updated Wed Jan  1 00:00:00 2026 UTC\nORG\nCOM\ncom\nNET\n"
    )

    assert version == "2026010100"
    assert tlds == ("com", "net", "org")


def test_parse_source_rejects_empty_source():
    with pytest.raises(ValueError, match="empty"):
        update_x_tlds.parse_source("")


def test_parse_source_rejects_missing_version_header():
    with pytest.raises(ValueError, match="version header"):
        update_x_tlds.parse_source("COM\nORG\n")


def test_parse_source_rejects_non_ascii_tld():
    with pytest.raises(ValueError, match="not ASCII"):
        update_x_tlds.parse_source("# Version 1, Last Updated x\nCAFÉ\n")


@pytest.mark.parametrize("bad_tld", ["foo bar", "-foo", "foo-", "foo.bar"])
def test_parse_source_rejects_invalid_tld_syntax(bad_tld):
    with pytest.raises(ValueError, match="invalid syntax"):
        update_x_tlds.parse_source(f"# Version 1, Last Updated x\n{bad_tld}\n")


def test_parse_source_rejects_source_without_tld_entries():
    with pytest.raises(ValueError, match="no TLD entries"):
        update_x_tlds.parse_source("# Version 1, Last Updated x\n# only comments\n   \n")


def test_update_generated_reads_source_file_and_writes_rendered_module(tmp_path, monkeypatch):
    source = tmp_path / "tlds.txt"
    source.write_text(
        "# Version 1, Last Updated x\nCOM\nORG\n",
        encoding="utf-8",
    )
    output = tmp_path / "x_tlds.py"
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.update_generated(source) == 0

    rendered = output.read_text(encoding="utf-8")
    assert 'IANA_TLD_VERSION = "1"' in rendered
    assert '        "com",' in rendered
    assert '        "org",' in rendered


def test_update_generated_rejects_malformed_source_without_replacing_output(tmp_path, monkeypatch):
    source = tmp_path / "tlds.txt"
    source.write_text("COM\nORG\n", encoding="utf-8")
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    with pytest.raises(ValueError, match="version header"):
        update_x_tlds.update_generated(source)

    assert output.read_text(encoding="utf-8") == original


def test_snapshot_has_version_and_expected_stable_entries():
    assert IANA_TLD_VERSION
    assert {"ai", "com", "dev", "museum", "xn--q9jyb4c"} <= IANA_TLDS


def test_check_generated_cli_accepts_checked_in_snapshot():
    command = [sys.executable, str(_UPDATE_SCRIPT), "--check"]

    # Trusted workspace tooling with constant argv; no user-controlled shell input.
    completed = subprocess.run(  # noqa: S603
        command,
        text=True,
        capture_output=True,
        check=False,
        timeout=_CLI_TIMEOUT_SECONDS,
    )

    assert completed.returncode == 0, (
        f"{_UPDATE_SCRIPT} --check failed with exit code {completed.returncode}.\n\n"
        f"stdout:\n{completed.stdout}\n\n"
        f"stderr:\n{completed.stderr}"
    )
