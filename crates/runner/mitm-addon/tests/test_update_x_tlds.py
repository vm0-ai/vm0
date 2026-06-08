from __future__ import annotations

import http.client
import io
import subprocess
import sys
import urllib.error
from collections.abc import Iterable
from email.message import Message
from pathlib import Path

import pytest

from scripts import update_x_tlds
from usage.providers.connectors.x_tlds import IANA_TLD_VERSION, IANA_TLDS

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_UPDATE_SCRIPT = _ADDON_ROOT / "scripts" / "update-x-tlds.py"
_CLI_TIMEOUT_SECONDS = 30


class _FailingOpener:
    def open(self, request: object, timeout: int) -> None:
        raise urllib.error.URLError("dns failed")


class _HttpErrorOpener:
    def open(self, request: object, timeout: int) -> None:
        raise urllib.error.HTTPError(
            update_x_tlds.SOURCE_URL,
            503,
            "Service Unavailable",
            Message(),
            io.BytesIO(b""),
        )


class _ReadFailureResponse:
    status = update_x_tlds.HTTPStatus.OK

    def __enter__(self) -> _ReadFailureResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        raise http.client.IncompleteRead(b"partial")


class _ReadFailureOpener:
    def open(self, request: object, timeout: int) -> _ReadFailureResponse:
        return _ReadFailureResponse()


def _build_failing_opener(*handlers: object) -> _FailingOpener:
    return _FailingOpener()


def _build_http_error_opener(*handlers: object) -> _HttpErrorOpener:
    return _HttpErrorOpener()


def _build_read_failure_opener(*handlers: object) -> _ReadFailureOpener:
    return _ReadFailureOpener()


def _source_text(version: str, tlds: Iterable[str]) -> str:
    return f"# Version {version}, Last Updated test\n" + "\n".join(sorted(tlds)) + "\n"


def _run_update_script(*args: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(_UPDATE_SCRIPT), *args]

    # Trusted workspace tooling with constant argv; no user-controlled shell input.
    return subprocess.run(  # noqa: S603
        command,
        text=True,
        capture_output=True,
        check=False,
        timeout=_CLI_TIMEOUT_SECONDS,
    )


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


def test_fetch_source_reports_url_error_as_fetch_error(monkeypatch):
    monkeypatch.setattr(update_x_tlds.urllib.request, "build_opener", _build_failing_opener)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    message = str(exc_info.value)
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in message
    assert "dns failed" in message


def test_fetch_source_preserves_http_error_status_message(monkeypatch):
    monkeypatch.setattr(update_x_tlds.urllib.request, "build_opener", _build_http_error_opener)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    assert str(exc_info.value) == f"failed to fetch {update_x_tlds.SOURCE_URL}: HTTP 503"


def test_fetch_source_reports_response_read_failure_as_fetch_error(monkeypatch):
    monkeypatch.setattr(update_x_tlds.urllib.request, "build_opener", _build_read_failure_opener)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    message = str(exc_info.value)
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in message
    assert "IncompleteRead" in message


def test_default_update_cli_reports_fetch_failure_without_replacing_output(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT)])
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)
    monkeypatch.setattr(update_x_tlds.urllib.request, "build_opener", _build_failing_opener)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in captured.err
    assert "dns failed" in captured.err
    assert "Traceback" not in captured.err
    assert output.read_text(encoding="utf-8") == original


def test_snapshot_has_version_and_expected_stable_entries():
    assert IANA_TLD_VERSION
    assert {"ai", "com", "dev", "museum", "xn--q9jyb4c"} <= IANA_TLDS


def test_compare_snapshot_to_source_accepts_version_only_drift():
    source_version = "9999999999"

    comparison = update_x_tlds.compare_snapshot_to_source(_source_text(source_version, IANA_TLDS))

    assert comparison.checked_version == IANA_TLD_VERSION
    assert comparison.source_version == source_version
    assert comparison.checked_count == len(IANA_TLDS)
    assert comparison.source_count == len(IANA_TLDS)
    assert not comparison.has_set_drift
    assert comparison.has_version_drift
    assert comparison.added == ()
    assert comparison.removed == ()


def test_compare_snapshot_to_source_reports_added_tlds():
    added_tld = "zzexampletest"
    source_tlds = set(IANA_TLDS)
    source_tlds.add(added_tld)

    comparison = update_x_tlds.compare_snapshot_to_source(
        _source_text(IANA_TLD_VERSION, source_tlds)
    )

    assert added_tld not in IANA_TLDS
    assert comparison.has_set_drift
    assert comparison.added == (added_tld,)
    assert comparison.removed == ()


def test_compare_snapshot_to_source_reports_removed_tlds():
    removed_tld = "com"
    source_tlds = set(IANA_TLDS)
    source_tlds.remove(removed_tld)

    comparison = update_x_tlds.compare_snapshot_to_source(
        _source_text(IANA_TLD_VERSION, source_tlds)
    )

    assert comparison.has_set_drift
    assert comparison.added == ()
    assert comparison.removed == (removed_tld,)


def test_check_generated_cli_accepts_checked_in_snapshot():
    completed = _run_update_script("--check")

    assert completed.returncode == 0, (
        f"{_UPDATE_SCRIPT} --check failed with exit code {completed.returncode}.\n\n"
        f"stdout:\n{completed.stdout}\n\n"
        f"stderr:\n{completed.stderr}"
    )


def test_check_source_cli_accepts_version_only_drift(tmp_path):
    source_version = "9999999999"
    source = tmp_path / "tlds.txt"
    source.write_text(_source_text(source_version, IANA_TLDS), encoding="utf-8")

    completed = _run_update_script("--check-source", "--source-file", str(source))

    assert completed.returncode == 0, (
        f"{_UPDATE_SCRIPT} --check-source failed with exit code {completed.returncode}.\n\n"
        f"stdout:\n{completed.stdout}\n\n"
        f"stderr:\n{completed.stderr}"
    )
    assert f"checked-in IANA TLD version {IANA_TLD_VERSION}" in completed.stdout
    assert f"source IANA TLD version {source_version}" in completed.stdout
    assert "version differs, but the TLD set is unchanged" in completed.stdout


def test_check_source_cli_reports_set_drift(tmp_path):
    added_tld = "zzexampletest"
    removed_tld = "com"
    source_tlds = set(IANA_TLDS)
    source_tlds.add(added_tld)
    source_tlds.remove(removed_tld)
    source = tmp_path / "tlds.txt"
    source.write_text(_source_text(IANA_TLD_VERSION, source_tlds), encoding="utf-8")

    completed = _run_update_script("--check-source", "--source-file", str(source))

    assert completed.returncode == 1
    assert f"checked-in IANA TLD version {IANA_TLD_VERSION}" in completed.stdout
    assert f"source IANA TLD version {IANA_TLD_VERSION}" in completed.stdout
    assert "IANA TLD set drift detected" in completed.stderr
    assert f"added: {added_tld}" in completed.stderr
    assert f"removed: {removed_tld}" in completed.stderr


def test_check_source_cli_requires_source_file():
    completed = _run_update_script("--check-source")

    assert completed.returncode != 0
    assert "--check-source requires --source-file" in completed.stderr
