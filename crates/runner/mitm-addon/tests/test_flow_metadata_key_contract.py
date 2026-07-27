"""Tests for the shared flow metadata key registry contract."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import flow_metadata_key_linter

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_FIXTURE_ROOT = _ADDON_ROOT / "tests" / "fixtures" / "flow_metadata_key_linter"
_CHECK_SCRIPT = _ADDON_ROOT / "scripts" / "check-flow-metadata-keys.py"
_CLI_TIMEOUT_SECONDS = 30
_COMPLEX_STAR_ARGS_TIMEOUT_SECONDS = 2
_COMPLEX_STAR_ARGS_BRANCH_COUNT = 24
_SUPPORTS_EXCEPT_STAR_SYNTAX = sys.version_info >= (3, 11)
_SUPPORTS_PEP695_SYNTAX = sys.version_info >= (3, 12)


def _fixture_text(*names: str) -> str:
    return "".join((_FIXTURE_ROOT / name).read_text(encoding="utf-8") for name in names)


def _expected_lines(name: str) -> list[str]:
    return (_FIXTURE_ROOT / name).read_text(encoding="utf-8").splitlines()


def _write_python_source(path: Path, *fixture_names: str) -> None:
    path.write_text(_fixture_text(*fixture_names), encoding="utf-8")


def _normalized_violations(source_path: Path, violations: list[str]) -> list[str]:
    return [violation.replace(str(source_path), source_path.name) for violation in violations]


def _violations_expected_fixture_name() -> str:
    if _SUPPORTS_PEP695_SYNTAX:
        return "violations.expected.py312.txt"
    if _SUPPORTS_EXCEPT_STAR_SYNTAX:
        return "violations.expected.py311.txt"
    return "violations.expected.py310.txt"


def _run_check_script(
    check_script: Path,
    addon_root: Path,
    executable_dir: Path,
    timeout_seconds: int = _CLI_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    python3 = executable_dir / "python3"
    python3.symlink_to(Path(sys.executable).resolve())
    env = {
        **os.environ,
        "LC_ALL": "C",
        "PATH": f"{executable_dir}{os.pathsep}{os.environ.get('PATH', '')}",
        "PYTHONCOERCECLOCALE": "0",
        "PYTHONUTF8": "0",
    }

    # Trusted workspace tooling with constant argv; no user-controlled shell input.
    return subprocess.run(  # noqa: S603
        [str(check_script)],
        cwd=addon_root,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_seconds,
    )


def _copy_linter_scripts(addon_root: Path) -> Path:
    scripts_root = addon_root / "scripts"
    scripts_root.mkdir(parents=True)
    check_script = scripts_root / _CHECK_SCRIPT.name
    shutil.copy2(_CHECK_SCRIPT, check_script)
    shutil.copy2(
        _ADDON_ROOT / "scripts" / "flow_metadata_key_linter.py",
        scripts_root / "flow_metadata_key_linter.py",
    )
    shutil.copytree(
        _ADDON_ROOT / "scripts" / "flow_metadata_linter",
        scripts_root / "flow_metadata_linter",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    return check_script


def test_registered_flow_metadata_keys_are_unique():
    assert flow_metadata_key_linter.duplicate_registered_metadata_keys() == {}


def test_registered_flow_metadata_keys_use_registry_constants():
    assert flow_metadata_key_linter.repository_metadata_key_violations() == []


def test_check_flow_metadata_keys_cli_passes_current_repository(tmp_path):
    result = _run_check_script(_CHECK_SCRIPT, _ADDON_ROOT, tmp_path)

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_check_flow_metadata_keys_cli_reports_configured_registry_path(tmp_path):
    addon_root = tmp_path / "mitm-addon"
    check_script = _copy_linter_scripts(addon_root)

    paths_file = addon_root / "scripts" / "flow_metadata_linter" / "paths.py"
    paths_file.write_text(
        paths_file.read_text(encoding="utf-8").replace(
            '"flow_metadata_keys.py"', '"renamed_flow_metadata_keys.py"'
        ),
        encoding="utf-8",
    )
    src_root = addon_root / "src"
    src_root.mkdir()
    (src_root / "renamed_flow_metadata_keys.py").write_text(
        'FIRST = "duplicate"\nSECOND = "duplicate"\n', encoding="utf-8"
    )

    result = _run_check_script(check_script, addon_root, tmp_path)

    assert result.returncode == 1
    assert result.stdout == (
        "src/renamed_flow_metadata_keys.py: duplicate metadata key 'duplicate': FIRST, SECOND\n"
    )
    assert result.stderr == ""


def test_check_flow_metadata_keys_cli_bounds_conditional_starred_arguments(tmp_path):
    addon_root = tmp_path / "mitm-addon"
    check_script = _copy_linter_scripts(addon_root)
    src_root = addon_root / "src"
    src_root.mkdir()
    (src_root / "flow_metadata_keys.py").write_text(
        'VM_RUN_ID = "vm_run_id"\n'
        'FIREWALL_NAME = "firewall_name"\n'
        'FIREWALL_ACTION = "firewall_action"\n',
        encoding="utf-8",
    )
    tests_root = addon_root / "tests"
    tests_root.mkdir()
    starred_elements = [
        '    *([] if c0 else ["vm_run_id"]),',
        '    *(["firewall_name"] if c1 else ["firewall_action"]),',
        *[
            f'    *(["external-{index}-left"] if c{index} else ["external-{index}-right"]),'
            for index in range(2, _COMPLEX_STAR_ARGS_BRANCH_COUNT)
        ],
    ]
    (tests_root / "complex_star_args.py").write_text(
        "flow.metadata.get(*[\n" + "\n".join(starred_elements) + "\n])\n",
        encoding="utf-8",
    )

    result = _run_check_script(
        check_script,
        addon_root,
        tmp_path,
        timeout_seconds=_COMPLEX_STAR_ARGS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert result.stdout == (
        "tests/complex_star_args.py:3: use metadata_keys.FIREWALL_NAME "
        "for flow.metadata access\n"
        "tests/complex_star_args.py:3: use metadata_keys.FIREWALL_ACTION "
        "for flow.metadata access\n"
        "tests/complex_star_args.py:2: use metadata_keys.VM_RUN_ID for flow.metadata access\n"
    )
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

    assert _normalized_violations(source_path, violations) == _expected_lines(
        _violations_expected_fixture_name()
    )


def test_registered_flow_metadata_guard_flags_direct_unbound_mapping_reads(tmp_path):
    source_path = tmp_path / "unbound_calls.py"
    _write_python_source(source_path, "unbound_calls.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "unbound_calls.expected.txt"
    )


def test_registered_flow_metadata_guard_flags_literals_after_dynamic_star_args(tmp_path):
    source_path = tmp_path / "dynamic_star_args.py"
    _write_python_source(source_path, "dynamic_star_args.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "dynamic_star_args.expected.txt"
    )


def test_registered_flow_metadata_guard_flags_composed_iterables(tmp_path):
    source_path = tmp_path / "composed_iterables.py"
    _write_python_source(source_path, "composed_iterables.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "composed_iterables.expected.txt"
    )


def test_registered_flow_metadata_guard_tracks_for_statement_variants(tmp_path):
    source_path = tmp_path / "for_statement_flow.py"
    _write_python_source(source_path, "for_statement_flow.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "for_statement_flow.expected.txt"
    )


def test_registered_flow_metadata_guard_tracks_context_manager_exception_paths(tmp_path):
    source_path = tmp_path / "context_manager_flow.py"
    _write_python_source(source_path, "context_manager_flow.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "context_manager_flow.expected.txt"
    )


def test_registered_flow_metadata_guard_tracks_implicit_exception_paths(tmp_path):
    source_path = tmp_path / "implicit_exception_flow.py"
    _write_python_source(source_path, "implicit_exception_flow.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "implicit_exception_flow.expected.txt"
    )


def test_registered_flow_metadata_guard_tracks_match_reachability(tmp_path):
    source_path = tmp_path / "match_reachability.py"
    _write_python_source(source_path, "match_reachability.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "match_reachability.expected.txt"
    )


def test_registered_flow_metadata_guard_tracks_with_item_binding_order(tmp_path):
    source_path = tmp_path / "with_item_bindings.py"
    _write_python_source(source_path, "with_item_bindings.base.py.txt")

    violations = flow_metadata_key_linter.metadata_key_violations(source_path)

    assert _normalized_violations(source_path, violations) == _expected_lines(
        "with_item_bindings.expected.txt"
    )


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
