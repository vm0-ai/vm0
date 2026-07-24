from __future__ import annotations

import hashlib
import http.client
import os
import py_compile
import ssl
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

import pytest

from scripts import update_x_tlds
from usage.providers.connectors.x_tlds import IANA_TLD_VERSION, IANA_TLDS

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_UPDATE_SCRIPT = _ADDON_ROOT / "scripts" / "update-x-tlds.py"
_CLI_TIMEOUT_SECONDS = 30
_EXPECTED_IANA_TLD_VERSION = "2026042600"
_EXPECTED_IANA_TLD_COUNT = 1437
_EXPECTED_IANA_TLD_SHA256 = "58c386314e69df471d34645b7614c8540a44ae110fc082f48434ea332a88ebc2"


class _FakeResponse:
    def __init__(
        self,
        *,
        status: int = update_x_tlds.HTTPStatus.OK,
        body: bytes = b"",
        read_error: Exception | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.read_error = read_error

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        if self.read_error is not None:
            raise self.read_error
        return self.body


class _FakeHttpsConnection:
    def __init__(
        self,
        response: _FakeResponse | None = None,
        request_error: Exception | None = None,
    ) -> None:
        self.response = response or _FakeResponse()
        self.request_error = request_error
        self.host: str | None = None
        self.options: dict[str, object] = {}
        self.request_args: tuple[str, str, dict[str, str]] | None = None
        self.closed = False

    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        self.request_args = (method, path, headers)
        if self.request_error is not None:
            raise self.request_error

    def getresponse(self) -> _FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


def _install_fake_connection(
    monkeypatch: pytest.MonkeyPatch,
    connection: _FakeHttpsConnection,
) -> None:
    def create_connection(host: str, **options: object) -> _FakeHttpsConnection:
        connection.host = host
        connection.options = options
        return connection

    monkeypatch.setattr(update_x_tlds.http.client, "HTTPSConnection", create_connection)


def _source_text(version: str, tlds: Iterable[str]) -> str:
    return f"# Version {version}, Last Updated test\n" + "\n".join(sorted(tlds)) + "\n"


def _write_generated_snapshot(path: Path) -> None:
    path.write_text(
        update_x_tlds.render_module(IANA_TLD_VERSION, tuple(sorted(IANA_TLDS))),
        encoding="utf-8",
    )


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


def test_fetch_source_uses_fixed_https_endpoint(monkeypatch):
    source = b"# Version 1, Last Updated test\nCOM\n"
    connection = _FakeHttpsConnection(_FakeResponse(body=source))
    _install_fake_connection(monkeypatch, connection)

    assert update_x_tlds.fetch_source() == source.decode("utf-8")
    assert connection.host == update_x_tlds.SOURCE_HOST
    assert connection.options["timeout"] == update_x_tlds.FETCH_TIMEOUT_SECONDS
    assert isinstance(connection.options["context"], ssl.SSLContext)
    assert connection.request_args == (
        "GET",
        update_x_tlds.SOURCE_PATH,
        {"User-Agent": "vm0-mitm-addon-tld-updater"},
    )
    assert connection.closed


def test_fetch_source_reports_url_error_as_fetch_error(monkeypatch):
    connection = _FakeHttpsConnection(request_error=OSError("dns failed"))
    _install_fake_connection(monkeypatch, connection)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    message = str(exc_info.value)
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in message
    assert "dns failed" in message
    assert connection.closed


def test_fetch_source_preserves_http_error_status_message(monkeypatch):
    connection = _FakeHttpsConnection(_FakeResponse(status=503))
    _install_fake_connection(monkeypatch, connection)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    assert str(exc_info.value) == f"failed to fetch {update_x_tlds.SOURCE_URL}: HTTP 503"
    assert connection.closed


def test_fetch_source_rejects_redirect_without_following_target(monkeypatch):
    connection = _FakeHttpsConnection(_FakeResponse(status=302))
    _install_fake_connection(monkeypatch, connection)

    with pytest.raises(update_x_tlds.TldFetchError, match=r"HTTP 302"):
        update_x_tlds.fetch_source()

    assert connection.host == update_x_tlds.SOURCE_HOST
    assert connection.request_args == (
        "GET",
        update_x_tlds.SOURCE_PATH,
        {"User-Agent": "vm0-mitm-addon-tld-updater"},
    )
    assert connection.closed


def test_fetch_source_reports_response_read_failure_as_fetch_error(monkeypatch):
    connection = _FakeHttpsConnection(
        _FakeResponse(read_error=http.client.IncompleteRead(b"partial"))
    )
    _install_fake_connection(monkeypatch, connection)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    message = str(exc_info.value)
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in message
    assert "IncompleteRead" in message
    assert connection.closed


def test_fetch_source_reports_invalid_utf8_body_as_fetch_error(monkeypatch):
    connection = _FakeHttpsConnection(_FakeResponse(body=b"\xff"))
    _install_fake_connection(monkeypatch, connection)

    with pytest.raises(update_x_tlds.TldFetchError) as exc_info:
        update_x_tlds.fetch_source()

    message = str(exc_info.value)
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in message
    assert "invalid UTF-8" in message
    assert connection.closed


def test_default_update_cli_reports_fetch_failure_without_replacing_output(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT)])
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)
    connection = _FakeHttpsConnection(request_error=OSError("dns failed"))
    _install_fake_connection(monkeypatch, connection)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert f"failed to fetch {update_x_tlds.SOURCE_URL}:" in captured.err
    assert "dns failed" in captured.err
    assert "Traceback" not in captured.err
    assert output.read_text(encoding="utf-8") == original
    assert connection.closed


def test_update_cli_reports_malformed_source_without_replacing_output(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "tlds.txt"
    source.write_text("COM\nORG\n", encoding="utf-8")
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT), "--source-file", str(source)])
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "IANA TLD source is missing the version header" in captured.err
    assert "Traceback" not in captured.err
    assert output.read_text(encoding="utf-8") == original


def test_update_script_reports_malformed_source_without_traceback(tmp_path):
    source = tmp_path / "tlds.txt"
    source.write_text("COM\nORG\n", encoding="utf-8")

    completed = _run_update_script("--source-file", str(source))

    assert completed.returncode == 1
    assert completed.stdout == ""
    assert "IANA TLD source is missing the version header" in completed.stderr
    assert "Traceback" not in completed.stderr


def test_update_cli_reports_invalid_utf8_source_without_replacing_output(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "tlds.txt"
    source.write_bytes(b"\xff")
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT), "--source-file", str(source)])
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert str(source) in captured.err
    assert "invalid UTF-8" in captured.err
    assert "Traceback" not in captured.err
    assert output.read_text(encoding="utf-8") == original


def test_update_cli_reports_missing_source_file_without_replacing_output(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "missing-tlds.txt"
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT), "--source-file", str(source)])
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert str(source) in captured.err
    assert "failed to read IANA TLD source file" in captured.err
    assert "Traceback" not in captured.err
    assert output.read_text(encoding="utf-8") == original


def test_snapshot_matches_pinned_integrity():
    snapshot_payload = "\n".join(sorted(IANA_TLDS)).encode("ascii")

    assert IANA_TLD_VERSION == _EXPECTED_IANA_TLD_VERSION
    assert len(IANA_TLDS) == _EXPECTED_IANA_TLD_COUNT
    assert hashlib.sha256(snapshot_payload).hexdigest() == _EXPECTED_IANA_TLD_SHA256


def test_check_cli_ignores_stale_timestamp_bytecode(tmp_path, monkeypatch, capsys):
    output = tmp_path / "x_tlds.py"
    initial = update_x_tlds.render_module("111", ("aaa",))
    updated = update_x_tlds.render_module("222", ("bbb",))
    timestamp_ns = 1_700_000_000_000_000_000

    assert len(initial.encode()) == len(updated.encode())

    output.write_text(initial, encoding="utf-8")
    os.utime(output, ns=(timestamp_ns, timestamp_ns))
    bytecode = py_compile.compile(
        str(output),
        doraise=True,
        invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP,
    )
    assert bytecode is not None
    assert Path(bytecode).is_file()

    output.write_text(updated, encoding="utf-8")
    os.utime(output, ns=(timestamp_ns, timestamp_ns))
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)
    monkeypatch.setattr(sys, "argv", [str(_UPDATE_SCRIPT), "--check"])

    assert update_x_tlds.main() == 0

    captured = capsys.readouterr()
    assert captured.out == f"{output} is canonical for IANA TLD version 222\n"
    assert captured.err == ""


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


def test_check_source_cli_reports_malformed_source_without_traceback(tmp_path, monkeypatch, capsys):
    source = tmp_path / "tlds.txt"
    source.write_text("COM\nORG\n", encoding="utf-8")
    output = tmp_path / "x_tlds.py"
    _write_generated_snapshot(output)
    monkeypatch.setattr(
        sys,
        "argv",
        [str(_UPDATE_SCRIPT), "--check-source", "--source-file", str(source)],
    )
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "IANA TLD source is missing the version header" in captured.err
    assert "Traceback" not in captured.err


def test_check_source_cli_reports_invalid_utf8_source_without_traceback(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "tlds.txt"
    source.write_bytes(b"\xff")
    output = tmp_path / "x_tlds.py"
    _write_generated_snapshot(output)
    monkeypatch.setattr(
        sys,
        "argv",
        [str(_UPDATE_SCRIPT), "--check-source", "--source-file", str(source)],
    )
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert str(source) in captured.err
    assert "invalid UTF-8" in captured.err
    assert "Traceback" not in captured.err


def test_check_source_cli_reports_missing_source_file_without_traceback(
    tmp_path, monkeypatch, capsys
):
    source = tmp_path / "missing-tlds.txt"
    output = tmp_path / "x_tlds.py"
    _write_generated_snapshot(output)
    monkeypatch.setattr(
        sys,
        "argv",
        [str(_UPDATE_SCRIPT), "--check-source", "--source-file", str(source)],
    )
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    assert update_x_tlds.main() == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert str(source) in captured.err
    assert "failed to read IANA TLD source file" in captured.err
    assert "Traceback" not in captured.err


def test_check_source_cli_does_not_hide_invalid_generated_snapshot(tmp_path, monkeypatch):
    source = tmp_path / "tlds.txt"
    source.write_text(_source_text("1", {"com"}), encoding="utf-8")
    output = tmp_path / "x_tlds.py"
    output.write_text(
        'IANA_TLD_VERSION = ""\nIANA_TLDS = frozenset({"com"})\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [str(_UPDATE_SCRIPT), "--check-source", "--source-file", str(source)],
    )
    monkeypatch.setattr(update_x_tlds, "OUTPUT_PATH", output)

    with pytest.raises(ValueError, match="invalid IANA_TLD_VERSION"):
        update_x_tlds.main()


def test_check_source_cli_requires_source_file():
    completed = _run_update_script("--check-source")

    assert completed.returncode != 0
    assert "--check-source requires --source-file" in completed.stderr
