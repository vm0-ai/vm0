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
_METADATA_METHODS_WITH_KEY_ARGUMENTS = {
    "__contains__",
    "__delitem__",
    "__getitem__",
    "__setitem__",
    "get",
    "pop",
    "setdefault",
}
_METADATA_METHODS_WITH_DICT_ARGUMENTS = {"__ior__", "update"}


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
    location = path.relative_to(_ADDON_ROOT) if path.is_relative_to(_ADDON_ROOT) else path
    line_number = getattr(node, "lineno", 0)
    return f"{location}:{line_number}: use metadata_keys.{key_name} for flow.metadata access"


class _MetadataKeyVisitor(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[str] = []
        self._metadata_alias_scopes: list[set[str]] = [set()]

    @property
    def _metadata_aliases(self) -> set[str]:
        return self._metadata_alias_scopes[-1]

    def _is_metadata_reference(self, node: ast.AST) -> bool:
        return _is_metadata_attribute(node) or (
            isinstance(node, ast.Name) and node.id in self._metadata_aliases
        )

    def _visit_scoped_body(self, body: list[ast.stmt]) -> None:
        self._metadata_alias_scopes.append(set(self._metadata_aliases))
        for statement in body:
            self.visit(statement)
        self._metadata_alias_scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_scoped_body(node.body)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_scoped_body(node.body)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._visit_scoped_body(node.body)

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(_is_metadata_attribute(target) for target in node.targets):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        self._update_aliases_from_assign(node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if _is_metadata_attribute(node.target):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        if isinstance(node.target, ast.Name):
            if node.value is not None and self._is_metadata_reference(node.value):
                self._metadata_aliases.add(node.target.id)
            else:
                self._metadata_aliases.discard(node.target.id)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if self._is_metadata_reference(node.target):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self._is_metadata_reference(node.value):
            key_name = _registered_key_name(node.slice)
            if key_name is not None:
                self.violations.append(_violation(self.path, node, key_name))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Attribute) and self._is_metadata_reference(node.func.value):
            if node.func.attr in _METADATA_METHODS_WITH_KEY_ARGUMENTS and node.args:
                key_name = _registered_key_name(node.args[0])
                if key_name is not None:
                    self.violations.append(_violation(self.path, node, key_name))
            if node.func.attr in _METADATA_METHODS_WITH_DICT_ARGUMENTS:
                self.violations.extend(_metadata_update_violations(self.path, node))
        self.generic_visit(node)

    def visit_Compare(self, node: ast.Compare) -> None:
        if (
            len(node.comparators) == 1
            and isinstance(node.ops[0], (ast.In, ast.NotIn))
            and self._is_metadata_reference(node.comparators[0])
        ):
            key_name = _registered_key_name(node.left)
            if key_name is not None:
                self.violations.append(_violation(self.path, node, key_name))
        self.generic_visit(node)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            if isinstance(target, ast.Name):
                self._metadata_aliases.discard(target.id)
        self.generic_visit(node)

    def _update_aliases_from_assign(self, node: ast.Assign) -> None:
        is_metadata_alias = self._is_metadata_reference(node.value)
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            if is_metadata_alias:
                self._metadata_aliases.add(target.id)
            else:
                self._metadata_aliases.discard(target.id)


def _metadata_key_violations(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    visitor = _MetadataKeyVisitor(path)
    visitor.visit(tree)
    return visitor.violations


def _metadata_update_violations(path: Path, node: ast.Call) -> list[str]:
    violations: list[str] = []
    update_arg = None if not node.args else node.args[0]
    violations.extend(_metadata_dict_key_violations(path, update_arg))
    violations.extend(_metadata_keyword_violations(path, node.keywords))
    return violations


def _metadata_dict_key_violations(path: Path, node: ast.AST | None) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.List | ast.Tuple):
        return _metadata_pair_sequence_violations(path, node)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return [
            *_metadata_dict_key_violations(path, node.left),
            *_metadata_dict_key_violations(path, node.right),
        ]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
        dict_call_violations: list[str] = []
        update_arg = None if not node.args else node.args[0]
        dict_call_violations.extend(_metadata_dict_key_violations(path, update_arg))
        dict_call_violations.extend(_metadata_keyword_violations(path, node.keywords))
        return dict_call_violations
    if not isinstance(node, ast.Dict):
        return []
    violations: list[str] = []
    for key, value in zip(node.keys, node.values, strict=True):
        if key is None:
            violations.extend(_metadata_dict_key_violations(path, value))
            continue
        key_name = _registered_key_name(key)
        if key_name is not None:
            violations.append(_violation(path, key, key_name))
    return violations


def _metadata_pair_sequence_violations(path: Path, node: ast.List | ast.Tuple) -> list[str]:
    violations: list[str] = []
    for item in node.elts:
        if not isinstance(item, ast.List | ast.Tuple) or len(item.elts) != 2:
            continue
        key_name = _registered_key_name(item.elts[0])
        if key_name is not None:
            violations.append(_violation(path, item.elts[0], key_name))
    return violations


def _metadata_keyword_violations(path: Path, keywords: list[ast.keyword]) -> list[str]:
    violations: list[str] = []
    for keyword in keywords:
        if keyword.arg is None:
            violations.extend(_metadata_dict_key_violations(path, keyword.value))
            continue
        key_name = _REGISTERED_METADATA_KEYS.get(keyword.arg)
        if key_name is not None:
            violations.append(_violation(path, keyword, key_name))
    return violations


def test_registered_flow_metadata_keys_use_registry_constants():
    violations = [
        violation for path in _python_files() for violation in _metadata_key_violations(path)
    ]

    assert violations == []


def test_registered_flow_metadata_guard_flags_direct_literals(tmp_path):
    source_path = tmp_path / "violations.py"
    source_path.write_text(
        """
flow.metadata["vm_run_id"] = "run-1"
flow.metadata.get("firewall_action")
"original_url" in flow.metadata
flow.metadata.update({"firewall_base": "https://api.example.com"})
flow.metadata.update(firewall_permission="read")
flow.metadata |= {"vm_network_log_path": "network.jsonl"}
flow.metadata = dict(vm_proxy_log_path="proxy.jsonl")
flow.metadata.update(dict([("stream_buffer", bytearray())]))
flow.metadata.update({**{"capture_body": True}})
flow.metadata = {"request_stream_buffer": bytearray()} | {"request_stream_buffer_state": {}}
flow.metadata.update(**{"trusted_authority_host": "api.example.com"})
flow.metadata.update([("http_request_start_monotonic", 1.0)])
flow.metadata.__getitem__("vm_sandbox_token")
flow.metadata.__setitem__("firewall_api_id", "run-1:0")
flow.metadata.__delitem__("network_log_target")
flow.metadata.__contains__("browser_user_agent")
flow.metadata.__ior__({"suppress_request_body_capture": True})
http_flow.metadata["vm_run_id"] = "run-2"
meta = flow.metadata
meta["vm_proxy_log_path"] = "proxy.jsonl"
meta.get("vm_network_log_path")
"firewall_name" in meta
meta.update({"firewall_permission": "read"})
meta |= {"firewall_rule_match": "GET /items"}
"""
    )

    violations = _metadata_key_violations(source_path)

    assert len(violations) == 24
    assert all("use metadata_keys." in violation for violation in violations)


def test_registered_flow_metadata_guard_ignores_external_schema_and_private_markers(
    tmp_path,
):
    source_path = tmp_path / "allowed.py"
    source_path.write_text(
        """
entry["firewall_name"] = "github"
payload = {"vm_run_id": "run-1"}
assert "connector_response_finish" in flow.metadata
flow.metadata["_local_marker"] = "private"
meta = flow.metadata
meta = {"vm_run_id": "external payload"}
"""
    )

    assert _metadata_key_violations(source_path) == []
