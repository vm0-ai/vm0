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


def _target_names(node: ast.AST | None) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.List | ast.Tuple):
        names: set[str] = set()
        for element in node.elts:
            names.update(_target_names(element))
        return names
    return set()


def _argument_names(args: ast.arguments) -> set[str]:
    names = {arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
    if args.vararg is not None:
        names.add(args.vararg.arg)
    if args.kwarg is not None:
        names.add(args.kwarg.arg)
    return names


class _MetadataKeyVisitor(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[str] = []
        self._metadata_alias_scopes: list[set[str]] = [set()]
        self._named_expr_target_scope_indexes: list[int] = []

    @property
    def _metadata_aliases(self) -> set[str]:
        return self._metadata_alias_scopes[-1]

    @property
    def _named_expr_target_aliases(self) -> set[str]:
        if not self._named_expr_target_scope_indexes:
            return self._metadata_aliases
        return self._metadata_alias_scopes[self._named_expr_target_scope_indexes[-1]]

    def _is_metadata_reference(self, node: ast.AST) -> bool:
        return (
            _is_metadata_attribute(node)
            or (isinstance(node, ast.Name) and node.id in self._metadata_aliases)
            or (isinstance(node, ast.NamedExpr) and self._is_metadata_reference(node.value))
        )

    def _visit_scoped_body(self, body: list[ast.stmt], shadowed: set[str] | None = None) -> None:
        aliases = set(self._metadata_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        for statement in body:
            self.visit(statement)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def _visit_scoped_expression(
        self, expression: ast.AST, shadowed: set[str] | None = None
    ) -> None:
        aliases = set(self._metadata_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        self.visit(expression)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        self._visit_scoped_body(node.body, _argument_names(node.args) | {node.name})
        self._metadata_aliases.discard(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        self._visit_scoped_body(node.body, _argument_names(node.args) | {node.name})
        self._metadata_aliases.discard(node.name)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        self._visit_scoped_expression(node.body, _argument_names(node.args))

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword)
        self._visit_scoped_body(node.body)
        self._metadata_aliases.discard(node.name)

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(_is_metadata_attribute(target) for target in node.targets):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        self._update_aliases_from_assign(node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if _is_metadata_attribute(node.target):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        if node.value is not None and isinstance(node.target, ast.Name):
            if self._is_metadata_reference(node.value):
                self._metadata_aliases.add(node.target.id)
            else:
                self._metadata_aliases.discard(node.target.id)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if self._is_metadata_reference(node.target):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        self.generic_visit(node)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        if isinstance(node.target, ast.Name):
            target_aliases = self._named_expr_target_aliases
            if self._is_metadata_reference(node.value):
                target_aliases.add(node.target.id)
                self._metadata_aliases.add(node.target.id)
            else:
                target_aliases.discard(node.target.id)
                self._metadata_aliases.discard(node.target.id)
        self.visit(node.value)

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
            for name in _target_names(target):
                self._metadata_aliases.discard(name)
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        self.visit(node.iter)
        self._discard_alias_target(node.target)
        for statement in node.body:
            self.visit(statement)
        for statement in node.orelse:
            self.visit(statement)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.visit(node.iter)
        self._discard_alias_target(node.target)
        for statement in node.body:
            self.visit(statement)
        for statement in node.orelse:
            self.visit(statement)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            self._discard_alias_target(item.optional_vars)
        for statement in node.body:
            self.visit(statement)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            self._discard_alias_target(item.optional_vars)
        for statement in node.body:
            self.visit(statement)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self.visit(node.type)
        if node.name is not None:
            self._metadata_aliases.discard(node.name)
        for statement in node.body:
            self.visit(statement)
        if node.name is not None:
            self._metadata_aliases.discard(node.name)

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension(node.generators, [node.key, node.value])

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._metadata_aliases.discard(alias.asname or alias.name.split(".", maxsplit=1)[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name == "*":
                self._metadata_aliases.clear()
            else:
                self._metadata_aliases.discard(alias.asname or alias.name)

    def _update_aliases_from_assign(self, node: ast.Assign) -> None:
        is_metadata_alias = self._is_metadata_reference(node.value)
        for target in node.targets:
            if is_metadata_alias and isinstance(target, ast.Name):
                self._metadata_aliases.add(target.id)
                continue
            for name in _target_names(target):
                self._metadata_aliases.discard(name)

    def _discard_alias_target(self, target: ast.AST | None) -> None:
        for name in _target_names(target):
            self._metadata_aliases.discard(name)

    def _visit_comprehension(
        self, generators: list[ast.comprehension], body_expressions: list[ast.AST]
    ) -> None:
        if not generators:
            for expression in body_expressions:
                self.visit(expression)
            return

        first_generator, *remaining_generators = generators
        self.visit(first_generator.iter)

        named_expr_target_scope_index = (
            self._named_expr_target_scope_indexes[-1]
            if self._named_expr_target_scope_indexes
            else len(self._metadata_alias_scopes) - 1
        )
        self._metadata_alias_scopes.append(set(self._metadata_aliases))
        self._named_expr_target_scope_indexes.append(named_expr_target_scope_index)
        self._discard_alias_target(first_generator.target)
        for condition in first_generator.ifs:
            self.visit(condition)
        for generator in remaining_generators:
            self.visit(generator.iter)
            self._discard_alias_target(generator.target)
            for condition in generator.ifs:
                self.visit(condition)
        for expression in body_expressions:
            self.visit(expression)
        self._named_expr_target_scope_indexes.pop()
        self._metadata_alias_scopes.pop()


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
def nested_alias():
    inner_meta = flow.metadata
    def uses_outer_alias():
        inner_meta["auth_cache_hit"] = False
annotated_meta = flow.metadata
annotated_meta: dict[str, object]
annotated_meta["auth_url_rewrite"] = True
(inline_meta := flow.metadata)["connector_diagnostic_type"] = "github"
(call_meta := flow.metadata).get("connector_diagnostic_reason")
if conditional_meta := flow.metadata:
    conditional_meta["connector_diagnostic_base"] = "https://api.example.com"
outer_meta = flow.metadata
values = [outer_meta["auth_refreshed_connectors"] for item in rows]
values = [(leaked_meta := flow.metadata) for item in rows]
leaked_meta["auth_refreshed_secrets"] = []
values = [[(nested_leaked_meta := flow.metadata) for item in row] for row in rows]
nested_leaked_meta["auth_resolved_secrets"] = []
values = [
    conditional_body_meta["model_provider_usage"]
    for item in rows
    if (conditional_body_meta := flow.metadata)
]
values = [
    generator_body_meta["model_provider_usage_sources"]
    for row in rows
    for item in (generator_body_meta := flow.metadata)
]
"""
    )

    violations = _metadata_key_violations(source_path)

    assert len(violations) == 34
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
def accepts_external_metadata(meta):
    return meta["vm_proxy_log_path"]
for meta in [{"firewall_name": "external"}]:
    value = meta["firewall_name"]
with context() as meta:
    value = meta["firewall_action"]
def meta():
    return None
value = meta["vm_run_id"]
class meta:
    pass
value = meta["vm_run_id"]
import json as meta
value = meta["vm_run_id"]
from json import dumps as meta
value = meta["vm_run_id"]
meta, other = flow.metadata
value = meta["vm_run_id"]
fn = lambda meta: meta["vm_run_id"]
values = [meta["vm_run_id"] for meta in [{"vm_run_id": "external"}]]
values = {meta["vm_run_id"] for meta in [{"vm_run_id": "external"}]}
values = {meta["vm_run_id"]: 1 for meta in [{"vm_run_id": "external"}]}
values = tuple(meta["vm_run_id"] for meta in [{"vm_run_id": "external"}])
[(lambda: (lambda_local_meta := flow.metadata))() for item in rows]
value = lambda_local_meta["vm_run_id"]
values = [(meta := {"vm_run_id": "external"}) for item in rows]
value = meta["vm_run_id"]
try:
    pass
except Exception as meta:
    value = meta["vm_run_id"]
"""
    )

    assert _metadata_key_violations(source_path) == []
