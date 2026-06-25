"""Tests for the shared flow metadata key registry contract."""

import ast
from pathlib import Path

import flow_metadata_keys as metadata_keys

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_SRC_ROOT = _ADDON_ROOT / "src"
_TESTS_ROOT = _ADDON_ROOT / "tests"
_METADATA_KEYS_FILE = _SRC_ROOT / "flow_metadata_keys.py"
_REGISTERED_METADATA_KEYS = {
    value: name
    for name, value in vars(metadata_keys).items()
    if name.isupper() and isinstance(value, str)
}
_METADATA_METHODS_WITH_KEY_ARGUMENTS = {"get", "pop", "setdefault"}


def _python_files() -> list[Path]:
    files: list[Path] = []
    for root in (_SRC_ROOT, _TESTS_ROOT):
        files.extend(path for path in root.rglob("*.py") if path != _METADATA_KEYS_FILE)
    return sorted(files)


def _is_metadata_attribute(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "metadata"


def _registered_key_name(node: ast.AST) -> str | None:
    if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
        return None
    return _REGISTERED_METADATA_KEYS.get(node.value)


def _violation(path: Path, node: ast.AST, key_name: str) -> str:
    location = path.relative_to(_ADDON_ROOT)
    return f"{location}:{node.lineno}: use metadata_keys.{key_name} for flow.metadata access"


def _metadata_key_violations(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    violations: list[str] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and _is_metadata_attribute(node.value):
            key_name = _registered_key_name(node.slice)
            if key_name is not None:
                violations.append(_violation(path, node, key_name))

        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and _is_metadata_attribute(node.func.value)
        ):
            if node.func.attr in _METADATA_METHODS_WITH_KEY_ARGUMENTS and node.args:
                key_name = _registered_key_name(node.args[0])
                if key_name is not None:
                    violations.append(_violation(path, node, key_name))
            if node.func.attr == "update":
                violations.extend(_metadata_update_violations(path, node))

        if isinstance(node, ast.Compare) and len(node.comparators) == 1:
            if not isinstance(node.ops[0], (ast.In, ast.NotIn)):
                continue
            if not _is_metadata_attribute(node.comparators[0]):
                continue
            key_name = _registered_key_name(node.left)
            if key_name is not None:
                violations.append(_violation(path, node, key_name))

    return violations


def _metadata_update_violations(path: Path, node: ast.Call) -> list[str]:
    if not node.args:
        return []
    update_arg = node.args[0]
    if not isinstance(update_arg, ast.Dict):
        return []
    violations: list[str] = []
    for key in update_arg.keys:
        if key is None:
            continue
        key_name = _registered_key_name(key)
        if key_name is not None:
            violations.append(_violation(path, key, key_name))
    return violations


def test_registered_flow_metadata_keys_use_registry_constants():
    violations = [
        violation for path in _python_files() for violation in _metadata_key_violations(path)
    ]

    assert violations == []
