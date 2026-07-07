"""Tests for the shared flow metadata key registry contract."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from scripts import flow_metadata_key_linter

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_FIXTURE_ROOT = _ADDON_ROOT / "tests" / "fixtures" / "flow_metadata_key_linter"
_CHECK_SCRIPT = _ADDON_ROOT / "scripts" / "check-flow-metadata-keys.py"
_CLI_TIMEOUT_SECONDS = 30
_SUPPORTS_EXCEPT_STAR_SYNTAX = sys.version_info >= (3, 11)
_SUPPORTS_PEP695_SYNTAX = sys.version_info >= (3, 12)


def _fixture_text(*names: str) -> str:
    return "".join((_FIXTURE_ROOT / name).read_text(encoding="utf-8") for name in names)


def _write_python_source(path: Path, *fixture_names: str) -> None:
    path.write_text(_fixture_text(*fixture_names), encoding="utf-8")


def test_registered_flow_metadata_keys_are_unique():
    assert flow_metadata_key_linter.duplicate_registered_metadata_keys() == {}


def test_registered_flow_metadata_keys_use_registry_constants():
    assert flow_metadata_key_linter.repository_metadata_key_violations() == []


def test_check_flow_metadata_keys_cli_passes_current_repository(tmp_path):
    python3 = tmp_path / "python3"
    python3.symlink_to(Path(sys.executable).resolve())
    env = {
        **os.environ,
        "LC_ALL": "C",
        "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}",
        "PYTHONCOERCECLOCALE": "0",
        "PYTHONUTF8": "0",
    }

    # Trusted workspace tooling with constant argv; no user-controlled shell input.
    result = subprocess.run(  # noqa: S603
        [str(_CHECK_SCRIPT)],
        cwd=_ADDON_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=_CLI_TIMEOUT_SECONDS,
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_registered_flow_metadata_guard_flags_direct_literals(tmp_path):
    source_path = tmp_path / "violations.py"
    fixture_names = ["violations.base.py.txt"]
    if _SUPPORTS_EXCEPT_STAR_SYNTAX:
        fixture_names.append("violations.py311.py.txt")
    if _SUPPORTS_PEP695_SYNTAX:
        fixture_names.append("violations.py312.py.txt")
    _write_python_source(source_path, *fixture_names)

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    expected_violation_count = 211
    if _SUPPORTS_EXCEPT_STAR_SYNTAX:
        expected_violation_count += 1
    if _SUPPORTS_PEP695_SYNTAX:
        expected_violation_count += 13
    assert len(violations) == expected_violation_count
    assert all("use metadata_keys." in violation for violation in violations)


def test_registered_flow_metadata_guard_flags_literals_after_dynamic_star_args(tmp_path):
    source_path = tmp_path / "dynamic_star_args.py"
    _write_python_source(source_path, "dynamic_star_args.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert len(violations) == 7
    assert any("metadata_keys.VM_RUN_ID" in violation for violation in violations)
    assert any("metadata_keys.FIREWALL_NAME" in violation for violation in violations)
    assert any("metadata_keys.FIREWALL_ACTION" in violation for violation in violations)
    assert any("metadata_keys.AUTH_CACHE_HIT" in violation for violation in violations)
    assert any("metadata_keys.FIREWALL_ERROR" in violation for violation in violations)
    assert any("metadata_keys.FIREWALL_PERMISSION" in violation for violation in violations)
    assert any("metadata_keys.VM_NETWORK_LOG_PATH" in violation for violation in violations)


def test_registered_flow_metadata_guard_respects_python_source_encoding(tmp_path):
    source_path = tmp_path / "latin1.py"
    source_path.write_bytes(b'# coding: latin-1\nflow.metadata["vm_run_id"] = "caf\xe9"\n')

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert len(violations) == 1
    assert "metadata_keys.VM_RUN_ID" in violations[0]


def test_registered_flow_metadata_guard_accepts_utf8_bom(tmp_path):
    source_path = tmp_path / "bom.py"
    source_path.write_bytes(b'\xef\xbb\xbfflow.metadata["vm_run_id"] = "run-1"\n')

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert len(violations) == 1
    assert "metadata_keys.VM_RUN_ID" in violations[0]


def test_registered_flow_metadata_guard_ignores_external_schema_and_private_markers(tmp_path):
    source_path = tmp_path / "allowed.py"
    fixture_names = ["allowed.base.py.txt"]
    if _SUPPORTS_PEP695_SYNTAX:
        fixture_names.append("allowed.py312.py.txt")
    _write_python_source(source_path, *fixture_names)

    assert flow_metadata_key_linter.metadata_key_violations(source_path) == []
