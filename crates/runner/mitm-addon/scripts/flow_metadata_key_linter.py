"""Lint registered ``flow.metadata`` key usage in the mitm addon."""

from __future__ import annotations

import ast
import importlib.util
import sys
import tokenize
from pathlib import Path
from types import ModuleType
from typing import TypeGuard

_ADDON_ROOT = Path(__file__).resolve().parents[1]
_SRC_ROOT = _ADDON_ROOT / "src"
_TESTS_ROOT = _ADDON_ROOT / "tests"
_METADATA_KEYS_FILE = _SRC_ROOT / "flow_metadata_keys.py"
_METADATA_PAIR_LENGTH = 2
_STRING_FORMAT_CONVERSION = ord("s")


def _load_metadata_keys() -> ModuleType:
    spec = importlib.util.spec_from_file_location("flow_metadata_keys", _METADATA_KEYS_FILE)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {_METADATA_KEYS_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metadata_keys = _load_metadata_keys()
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
_SEQUENCE_WRAPPER_CALLS = {"frozenset", "iter", "list", "reversed", "set", "sorted", "tuple"}


def _python_files() -> list[Path]:
    files: list[Path] = []
    for root in (_SRC_ROOT, _TESTS_ROOT):
        files.extend(path for path in root.rglob("*.py") if path != _METADATA_KEYS_FILE)
    return sorted(files)


def _is_metadata_attribute(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "metadata"


def _registered_key_name(node: ast.AST) -> str | None:
    value = _static_string_value(node)
    if value is None:
        return None
    return _REGISTERED_METADATA_KEYS.get(value)


def _static_string_value(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
                continue
            if (
                isinstance(value, ast.FormattedValue)
                and value.conversion in {-1, _STRING_FORMAT_CONVERSION}
                and _is_plain_string_format_spec(value.format_spec)
            ):
                formatted_value = _static_string_value(value.value)
                if formatted_value is not None:
                    parts.append(formatted_value)
                    continue
                return None
            return None
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _static_string_value(node.left)
        right = _static_string_value(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def _is_plain_string_format_spec(node: ast.AST | None) -> bool:
    if node is None:
        return True
    spec = _static_string_value(node)
    return spec in {"", "s"}


def _violation(path: Path, node: ast.AST, key_name: str) -> str:
    location = path.relative_to(_ADDON_ROOT) if path.is_relative_to(_ADDON_ROOT) else path
    line_number = getattr(node, "lineno", 0)
    return f"{location}:{line_number}: use metadata_keys.{key_name} for flow.metadata access"


def _target_names(node: ast.AST | None) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Starred):
        return _target_names(node.value)
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


def _argument_annotations(args: ast.arguments) -> list[ast.expr]:
    annotations = [
        arg.annotation for arg in [*args.posonlyargs, *args.args] if arg.annotation is not None
    ]
    if args.vararg is not None and args.vararg.annotation is not None:
        annotations.append(args.vararg.annotation)
    annotations.extend(arg.annotation for arg in args.kwonlyargs if arg.annotation is not None)
    if args.kwarg is not None and args.kwarg.annotation is not None:
        annotations.append(args.kwarg.annotation)
    return annotations


def _static_call_argument_nodes(args: list[ast.expr], index: int) -> list[ast.AST]:
    result: list[ast.AST] = []
    consumed_counts = [0]
    for argument in args:
        next_consumed_counts: list[int] = []
        if isinstance(argument, ast.Starred):
            expansions, has_unknown_expansion = _static_starred_argument_expansions(argument.value)
            for consumed in consumed_counts:
                for expansion in expansions:
                    for offset, expanded_argument in enumerate(expansion):
                        if consumed + offset == index:
                            result.append(expanded_argument)
                    next_consumed_counts.append(consumed + len(expansion))
            if has_unknown_expansion:
                next_consumed_counts.extend(
                    consumed for consumed in consumed_counts if consumed <= index
                )
        else:
            for consumed in consumed_counts:
                if consumed == index:
                    result.append(argument)
                next_consumed_counts.append(consumed + 1)
        consumed_counts = next_consumed_counts
    return result


def _static_starred_argument_expansions(node: ast.AST) -> tuple[list[list[ast.AST]], bool]:
    if isinstance(node, ast.NamedExpr):
        return _static_starred_argument_expansions(node.value)
    if isinstance(node, ast.IfExp):
        body_expansions, body_has_unknown_expansion = _static_starred_argument_expansions(node.body)
        orelse_expansions, orelse_has_unknown_expansion = _static_starred_argument_expansions(
            node.orelse
        )
        return [
            *body_expansions,
            *orelse_expansions,
        ], body_has_unknown_expansion or orelse_has_unknown_expansion
    if isinstance(node, ast.BoolOp):
        expansions: list[list[ast.AST]] = []
        has_unknown_expansion = False
        for value in node.values:
            value_expansions, value_has_unknown_expansion = _static_starred_argument_expansions(
                value
            )
            expansions.extend(value_expansions)
            has_unknown_expansion = has_unknown_expansion or value_has_unknown_expansion
        return expansions, has_unknown_expansion
    if not isinstance(node, ast.List | ast.Tuple):
        return [], True
    expansions = [[]]
    has_unknown_expansion = False
    for element in node.elts:
        if isinstance(element, ast.Starred):
            nested_expansions, nested_has_unknown_expansion = _static_starred_argument_expansions(
                element.value
            )
            next_expansions: list[list[ast.AST]] = []
            if nested_expansions:
                next_expansions.extend(
                    [*prefix, *nested] for prefix in expansions for nested in nested_expansions
                )
            if nested_has_unknown_expansion:
                next_expansions.extend(expansions)
            expansions = next_expansions
            has_unknown_expansion = has_unknown_expansion or nested_has_unknown_expansion
        else:
            expansions = [[*prefix, element] for prefix in expansions]
    return expansions, has_unknown_expansion


def _type_params(node: ast.AST) -> list[ast.AST]:
    for field_name, value in ast.iter_fields(node):
        if field_name == "type_params" and isinstance(value, list):
            return [item for item in value if isinstance(item, ast.AST)]
    return []


def _type_param_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for type_param in _type_params(node):
        for field_name, value in ast.iter_fields(type_param):
            if field_name == "name" and isinstance(value, str):
                names.add(value)
    return names


def _type_alias_target_names(node: ast.AST) -> set[str]:
    for field_name, value in ast.iter_fields(node):
        if field_name == "name" and isinstance(value, ast.AST):
            return _target_names(value)
    return set()


def _type_alias_value(node: ast.AST) -> ast.AST | None:
    for field_name, value in ast.iter_fields(node):
        if field_name == "value" and isinstance(value, ast.AST):
            return value
    return None


class _ScopeBoundNameVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bound_names: set[str] = set()
        self.global_names: set[str] = set()
        self.nonlocal_names: set[str] = set()

    @property
    def local_names(self) -> set[str]:
        return self.bound_names - self.global_names - self.nonlocal_names

    def visit_Global(self, node: ast.Global) -> None:
        self.global_names.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.nonlocal_names.update(node.names)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.bound_names.add(node.name)
        self._visit_function_definition_expressions(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.bound_names.add(node.name)
        self._visit_function_definition_expressions(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.bound_names.add(node.name)
        for decorator in node.decorator_list:
            self.visit(decorator)
        for type_param in _type_params(node):
            self.visit(type_param)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword)

    def visit_TypeAlias(self, node: ast.AST) -> None:
        self.bound_names.update(_type_alias_target_names(node))

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self.bound_names.update(_target_names(target))
            self.visit(target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
        self.visit(node.annotation)
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)
        self.visit(node.value)

    def _visit_for_statement(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)
        for statement in [*node.body, *node.orelse]:
            self.visit(statement)

    def visit_For(self, node: ast.For) -> None:
        self._visit_for_statement(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._visit_for_statement(node)

    def _visit_with_statement(self, node: ast.With | ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            self.bound_names.update(_target_names(item.optional_vars))
            if item.optional_vars is not None:
                self.visit(item.optional_vars)
        for statement in node.body:
            self.visit(statement)

    def visit_With(self, node: ast.With) -> None:
        self._visit_with_statement(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        self._visit_with_statement(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self.visit(node.type)
        if node.name is not None:
            self.bound_names.add(node.name)
        for statement in node.body:
            self.visit(statement)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            self.bound_names.update(_target_names(target))
            self.visit(target)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.bound_names.update(_target_names(node.target))
        self.visit(node.value)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.bound_names.add(alias.asname or alias.name.split(".", maxsplit=1)[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*":
                self.bound_names.add(alias.asname or alias.name)

    def visit_Match(self, node: ast.Match) -> None:
        self.visit(node.subject)
        for case in node.cases:
            self.bound_names.update(_pattern_names(case.pattern))
            if case.guard is not None:
                self.visit(case.guard)
            for statement in case.body:
                self.visit(statement)

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.key, node.value])

    def _visit_function_definition_expressions(
        self, node: ast.FunctionDef | ast.AsyncFunctionDef
    ) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for type_param in _type_params(node):
            self.visit(type_param)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        for annotation in _argument_annotations(node.args):
            self.visit(annotation)
        if node.returns is not None:
            self.visit(node.returns)

    def _visit_comprehension_expressions(
        self, generators: list[ast.comprehension], body_expressions: list[ast.AST]
    ) -> None:
        for generator in generators:
            self.visit(generator.iter)
            for condition in generator.ifs:
                self.visit(condition)
        for expression in body_expressions:
            self.visit(expression)


def _scope_bound_name_visitor(body: list[ast.stmt]) -> _ScopeBoundNameVisitor:
    visitor = _ScopeBoundNameVisitor()
    for statement in body:
        visitor.visit(statement)
    return visitor


def _scope_bound_names(body: list[ast.stmt]) -> set[str]:
    return _scope_bound_name_visitor(body).local_names


def _expression_bound_names(expression: ast.AST) -> set[str]:
    visitor = _ScopeBoundNameVisitor()
    visitor.visit(expression)
    return visitor.local_names


def _pattern_names(pattern: ast.pattern) -> set[str]:
    if isinstance(pattern, ast.MatchAs):
        names = set() if pattern.name is None else {pattern.name}
        if pattern.pattern is not None:
            names.update(_pattern_names(pattern.pattern))
        return names
    if isinstance(pattern, ast.MatchStar):
        return set() if pattern.name is None else {pattern.name}
    if isinstance(pattern, ast.MatchMapping):
        mapping_names: set[str] = set() if pattern.rest is None else {pattern.rest}
        for child_pattern in pattern.patterns:
            mapping_names.update(_pattern_names(child_pattern))
        return mapping_names
    if isinstance(pattern, ast.MatchSequence):
        sequence_names: set[str] = set()
        for child_pattern in pattern.patterns:
            sequence_names.update(_pattern_names(child_pattern))
        return sequence_names
    if isinstance(pattern, ast.MatchClass):
        class_names: set[str] = set()
        for child_pattern in [*pattern.patterns, *pattern.kwd_patterns]:
            class_names.update(_pattern_names(child_pattern))
        return class_names
    if isinstance(pattern, ast.MatchOr):
        or_names: set[str] = set()
        for child_pattern in pattern.patterns:
            or_names.update(_pattern_names(child_pattern))
        return or_names
    return set()


def _metadata_match_pattern_alias_names(pattern: ast.pattern) -> set[str]:
    if isinstance(pattern, ast.MatchAs):
        names = set() if pattern.name is None else {pattern.name}
        if pattern.pattern is not None:
            names.update(_metadata_match_pattern_alias_names(pattern.pattern))
        return names
    if isinstance(pattern, ast.MatchMapping):
        return set() if pattern.rest is None else {pattern.rest}
    if isinstance(pattern, ast.MatchOr):
        names: set[str] = set()
        for child_pattern in pattern.patterns:
            names.update(_metadata_match_pattern_alias_names(child_pattern))
        return names
    return set()


def _pattern_is_exhaustive(pattern: ast.pattern) -> bool:
    if isinstance(pattern, ast.MatchAs):
        return pattern.pattern is None or _pattern_is_exhaustive(pattern.pattern)
    if isinstance(pattern, ast.MatchOr):
        return any(_pattern_is_exhaustive(child_pattern) for child_pattern in pattern.patterns)
    return False


def _body_can_fall_through(body: list[ast.stmt]) -> bool:
    return all(_statement_can_fall_through(statement) for statement in body)


def _is_try_statement(statement: ast.stmt) -> TypeGuard[ast.Try]:
    return isinstance(statement, ast.Try) or statement.__class__.__name__ == "TryStar"


def _statement_can_fall_through(statement: ast.stmt) -> bool:
    if isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
        return False
    if isinstance(statement, ast.If):
        if not statement.orelse:
            return True
        return _body_can_fall_through(statement.body) or _body_can_fall_through(statement.orelse)
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        return _body_can_fall_through(statement.body)
    if _is_try_statement(statement):
        if statement.finalbody and not _body_can_fall_through(statement.finalbody):
            return False
        normal_path_falls_through = _body_can_fall_through(statement.body)
        if normal_path_falls_through and statement.orelse:
            normal_path_falls_through = _body_can_fall_through(statement.orelse)
        handler_path_falls_through = any(
            _body_can_fall_through(handler.body) for handler in statement.handlers
        )
        return normal_path_falls_through or handler_path_falls_through
    return True


class _MetadataKeyVisitor(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[str] = []
        self._violation_messages: set[str] = set()
        self._metadata_alias_scopes: list[set[str]] = [set()]
        self._class_nested_scope_alias_scopes: list[set[str]] = []
        self._metadata_key_checked_node_ids: set[int] = set()
        self._named_expr_target_scope_indexes: list[int] = []

    @property
    def _metadata_aliases(self) -> set[str]:
        return self._metadata_alias_scopes[-1]

    @property
    def _named_expr_target_aliases(self) -> set[str]:
        if not self._named_expr_target_scope_indexes:
            return self._metadata_aliases
        return self._metadata_alias_scopes[self._named_expr_target_scope_indexes[-1]]

    def _add_violation(self, violation: str) -> None:
        if violation in self._violation_messages:
            return
        self._violation_messages.add(violation)
        self.violations.append(violation)

    def _add_violations(self, violations: list[str]) -> None:
        for violation in violations:
            self._add_violation(violation)

    def visit(self, node: ast.AST) -> None:
        self._record_metadata_merge_key_violations(node)
        super().visit(node)

    def _is_metadata_reference(self, node: ast.AST) -> bool:
        return (
            _is_metadata_attribute(node)
            or (isinstance(node, ast.Name) and node.id in self._metadata_aliases)
            or (isinstance(node, ast.NamedExpr) and self._is_metadata_alias_value(node.value))
        )

    def _is_metadata_alias_value(self, node: ast.AST) -> bool:
        if self._is_metadata_reference(node) or self._is_metadata_merge_value(node):
            return True
        if isinstance(node, ast.IfExp):
            return self._is_metadata_alias_value(node.body) or self._is_metadata_alias_value(
                node.orelse
            )
        if isinstance(node, ast.BoolOp):
            return any(self._is_metadata_alias_value(value) for value in node.values)
        if isinstance(node, ast.Await):
            return self._is_metadata_alias_value(node.value)
        if isinstance(node, ast.UnaryOp) and not isinstance(node.op, ast.Not):
            return self._is_metadata_alias_value(node.operand)
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "copy"
            and self._is_metadata_alias_value(node.func.value)
        )

    def _is_metadata_merge_value(self, node: ast.AST) -> bool:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            left_is_metadata = self._is_metadata_alias_value(node.left)
            right_is_metadata = self._is_metadata_alias_value(node.right)
            return left_is_metadata or right_is_metadata
        if isinstance(node, ast.Dict) and any(
            key is None and self._is_metadata_alias_value(value)
            for key, value in zip(node.keys, node.values, strict=True)
        ):
            return True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "dict"
        ):
            positional_metadata = any(
                self._is_metadata_alias_value(argument) for argument in node.args
            )
            unpacked_keyword_metadata = any(
                keyword.arg is None and self._is_metadata_alias_value(keyword.value)
                for keyword in node.keywords
            )
            return positional_metadata or unpacked_keyword_metadata
        return False

    def _metadata_merge_key_violations(self, node: ast.AST) -> list[str]:
        if self._is_metadata_merge_value(node):
            return _metadata_dict_key_violations(self.path, node)
        if isinstance(node, ast.IfExp):
            return [
                *self._metadata_merge_key_violations(node.body),
                *self._metadata_merge_key_violations(node.orelse),
            ]
        if isinstance(node, ast.BoolOp):
            violations: list[str] = []
            for value in node.values:
                violations.extend(self._metadata_merge_key_violations(value))
            return violations
        return []

    def _record_metadata_merge_key_violations(self, node: ast.AST | None) -> None:
        if node is None:
            return
        node_id = id(node)
        if node_id in self._metadata_key_checked_node_ids:
            return
        violations = self._metadata_merge_key_violations(node)
        if not violations:
            return
        self._metadata_key_checked_node_ids.add(node_id)
        self._add_violations(violations)

    def _record_metadata_dict_key_violations(self, node: ast.AST | None) -> None:
        if node is None:
            return
        node_id = id(node)
        if node_id in self._metadata_key_checked_node_ids:
            return
        violations = _metadata_dict_key_violations(self.path, node)
        if not violations:
            return
        self._metadata_key_checked_node_ids.add(node_id)
        self._add_violations(violations)

    def _metadata_default_argument_names(self, args: ast.arguments) -> set[str]:
        metadata_defaults: set[str] = set()
        positional_args = [*args.posonlyargs, *args.args]
        default_offset = len(positional_args) - len(args.defaults)
        for arg, default in zip(positional_args[default_offset:], args.defaults, strict=True):
            if self._is_metadata_alias_value(default):
                metadata_defaults.add(arg.arg)
        for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=True):
            if default is not None and self._is_metadata_alias_value(default):
                metadata_defaults.add(arg.arg)
        return metadata_defaults

    def _visit_default_value(self, node: ast.AST) -> None:
        self._record_metadata_merge_key_violations(node)
        self.visit(node)

    def _replace_current_aliases(self, aliases: set[str]) -> None:
        self._metadata_aliases.clear()
        self._metadata_aliases.update(aliases)

    def _visit_definition_expression(
        self,
        node: ast.AST,
        shadowed_names: set[str],
        *,
        check_metadata_merge: bool = False,
    ) -> None:
        outer_aliases = set(self._metadata_aliases)
        self._metadata_aliases.difference_update(shadowed_names)
        if check_metadata_merge:
            self._record_metadata_merge_key_violations(node)
        self.visit(node)
        expression_aliases = set(self._metadata_aliases)
        self._replace_current_aliases(
            (expression_aliases - shadowed_names) | (outer_aliases & shadowed_names)
        )

    def _nested_function_base_aliases(self) -> set[str]:
        if self._class_nested_scope_alias_scopes:
            return set(self._class_nested_scope_alias_scopes[-1])
        return set(self._metadata_aliases)

    def _visit_current_scope_body(self, body: list[ast.stmt]) -> bool:
        for statement in body:
            self.visit(statement)
            if not _statement_can_fall_through(statement):
                return False
        return True

    def _visit_branch_body(self, body: list[ast.stmt], aliases: set[str]) -> tuple[set[str], bool]:
        self._metadata_alias_scopes.append(set(aliases))
        falls_through = self._visit_current_scope_body(body)
        result = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        return result, falls_through

    def _visit_branch_body_state_only(
        self, body: list[ast.stmt], aliases: set[str]
    ) -> tuple[set[str], bool]:
        violation_count = len(self.violations)
        violation_messages = set(self._violation_messages)
        checked_node_ids = set(self._metadata_key_checked_node_ids)
        result = self._visit_branch_body(body, aliases)
        del self.violations[violation_count:]
        self._violation_messages = violation_messages
        self._metadata_key_checked_node_ids = checked_node_ids
        return result

    def _visit_except_handler_branch(
        self, handler: ast.ExceptHandler, aliases: set[str]
    ) -> tuple[set[str], bool]:
        self._metadata_alias_scopes.append(set(aliases))
        if handler.type is not None:
            self._record_metadata_merge_key_violations(handler.type)
            self.visit(handler.type)
        if handler.name is not None:
            self._metadata_aliases.discard(handler.name)
        falls_through = self._visit_current_scope_body(handler.body)
        result = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        return result, falls_through

    def _visit_scoped_body(
        self,
        body: list[ast.stmt],
        shadowed: set[str] | None = None,
        added: set[str] | None = None,
        base_aliases: set[str] | None = None,
    ) -> None:
        aliases = set(self._metadata_aliases if base_aliases is None else base_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        if added is not None:
            aliases.update(added)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        self._visit_current_scope_body(body)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def _visit_scoped_expression(
        self,
        expression: ast.AST,
        shadowed: set[str] | None = None,
        added: set[str] | None = None,
        base_aliases: set[str] | None = None,
    ) -> None:
        aliases = set(self._metadata_aliases if base_aliases is None else base_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        if added is not None:
            aliases.update(added)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        self._record_metadata_merge_key_violations(expression)
        self.visit(expression)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        for decorator in node.decorator_list:
            self._visit_definition_expression(decorator, set(), check_metadata_merge=True)
        type_param_names = _type_param_names(node)
        for type_param in _type_params(node):
            self._visit_definition_expression(
                type_param, type_param_names, check_metadata_merge=True
            )
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        for annotation in _argument_annotations(node.args):
            self._visit_definition_expression(
                annotation, type_param_names, check_metadata_merge=True
            )
        if node.returns is not None:
            self._visit_definition_expression(
                node.returns, type_param_names, check_metadata_merge=True
            )
        body_scope_bindings = _scope_bound_name_visitor(node.body)
        body_global_names = body_scope_bindings.global_names
        shadowed_names = (
            (
                _argument_names(node.args)
                | body_scope_bindings.local_names
                | (type_param_names - body_global_names)
            )
            - metadata_defaults
        ) | {node.name}
        body_base_aliases = self._nested_function_base_aliases()
        body_base_aliases.difference_update(body_global_names)
        body_base_aliases.update(self._metadata_alias_scopes[0] & body_global_names)
        self._visit_scoped_body(node.body, shadowed_names, metadata_defaults, body_base_aliases)
        self._metadata_aliases.discard(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self._visit_definition_expression(decorator, set(), check_metadata_merge=True)
        type_param_names = _type_param_names(node)
        for type_param in _type_params(node):
            self._visit_definition_expression(
                type_param, type_param_names, check_metadata_merge=True
            )
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        for annotation in _argument_annotations(node.args):
            self._visit_definition_expression(
                annotation, type_param_names, check_metadata_merge=True
            )
        if node.returns is not None:
            self._visit_definition_expression(
                node.returns, type_param_names, check_metadata_merge=True
            )
        body_scope_bindings = _scope_bound_name_visitor(node.body)
        body_global_names = body_scope_bindings.global_names
        shadowed_names = (
            (
                _argument_names(node.args)
                | body_scope_bindings.local_names
                | (type_param_names - body_global_names)
            )
            - metadata_defaults
        ) | {node.name}
        body_base_aliases = self._nested_function_base_aliases()
        body_base_aliases.difference_update(body_global_names)
        body_base_aliases.update(self._metadata_alias_scopes[0] & body_global_names)
        self._visit_scoped_body(node.body, shadowed_names, metadata_defaults, body_base_aliases)
        self._metadata_aliases.discard(node.name)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        self._visit_scoped_expression(
            node.body,
            (_argument_names(node.args) | _expression_bound_names(node.body)) - metadata_defaults,
            metadata_defaults,
            self._nested_function_base_aliases(),
        )

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for decorator in node.decorator_list:
            self._visit_definition_expression(decorator, set(), check_metadata_merge=True)
        type_param_names = _type_param_names(node)
        for type_param in _type_params(node):
            self._visit_definition_expression(
                type_param, type_param_names, check_metadata_merge=True
            )
        for base in node.bases:
            self._visit_definition_expression(base, type_param_names, check_metadata_merge=True)
        for keyword in node.keywords:
            self._visit_definition_expression(keyword, type_param_names, check_metadata_merge=True)
        outer_aliases = self._nested_function_base_aliases() - type_param_names
        class_scope_bindings = _scope_bound_name_visitor(node.body)
        class_body_bound_names = class_scope_bindings.local_names
        class_body_global_names = class_scope_bindings.global_names
        class_body_aliases = outer_aliases - class_body_bound_names - class_body_global_names
        class_body_aliases.update(
            self._metadata_alias_scopes[0] & (class_body_bound_names | class_body_global_names)
        )
        self._class_nested_scope_alias_scopes.append(outer_aliases)
        self._visit_scoped_body(node.body, base_aliases=class_body_aliases)
        self._class_nested_scope_alias_scopes.pop()
        self._metadata_aliases.discard(node.name)

    def visit_TypeAlias(self, node: ast.AST) -> None:
        type_param_names = _type_param_names(node)
        target_names = _type_alias_target_names(node)
        shadowed_names = type_param_names | target_names
        for type_param in _type_params(node):
            self._visit_definition_expression(type_param, shadowed_names, check_metadata_merge=True)
        value = _type_alias_value(node)
        if value is not None:
            self._visit_definition_expression(value, shadowed_names, check_metadata_merge=True)
        for name in target_names:
            self._metadata_aliases.discard(name)

    def _visit_type_parameter(self, node: ast.AST) -> None:
        for _field_name, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                self._record_metadata_merge_key_violations(value)
                self.visit(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        self._record_metadata_merge_key_violations(item)
                        self.visit(item)

    def visit_TypeVar(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_ParamSpec(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_TypeVarTuple(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(_is_metadata_attribute(target) for target in node.targets):
            self._record_metadata_dict_key_violations(node.value)
        else:
            self._record_metadata_merge_key_violations(node.value)
        self.visit(node.value)
        for target in node.targets:
            self.visit(target)
        self._update_aliases_from_assign(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if _is_metadata_attribute(node.target):
            self._record_metadata_dict_key_violations(node.value)
        elif node.value is not None:
            self._record_metadata_merge_key_violations(node.value)
        if node.value is not None:
            self.visit(node.value)
        self._record_metadata_merge_key_violations(node.annotation)
        self.visit(node.annotation)
        self.visit(node.target)
        if node.value is not None and isinstance(node.target, ast.Name):
            if self._is_metadata_alias_value(node.value):
                self._metadata_aliases.add(node.target.id)
            else:
                self._metadata_aliases.discard(node.target.id)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        target_is_metadata = self._is_metadata_reference(node.target)
        value_is_metadata_merge = self._is_metadata_merge_value(node.value)
        if target_is_metadata:
            self._record_metadata_dict_key_violations(node.value)
        elif value_is_metadata_merge:
            self._record_metadata_merge_key_violations(node.value)
        self.visit(node.target)
        self.visit(node.value)
        if (
            isinstance(node.op, ast.BitOr)
            and isinstance(node.target, ast.Name)
            and (target_is_metadata or value_is_metadata_merge)
        ):
            self._metadata_aliases.add(node.target.id)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        if isinstance(node.target, ast.Name):
            is_metadata_alias = self._is_metadata_alias_value(node.value)
            self._record_metadata_merge_key_violations(node.value)
            self.visit(node.value)
            target_aliases = self._named_expr_target_aliases
            if is_metadata_alias:
                target_aliases.add(node.target.id)
                self._metadata_aliases.add(node.target.id)
            else:
                target_aliases.discard(node.target.id)
                self._metadata_aliases.discard(node.target.id)
            return
        self.visit(node.value)

    def _visit_sequence_expression(self, node: ast.List | ast.Tuple | ast.Set) -> None:
        for element in node.elts:
            self._record_metadata_merge_key_violations(element)
        self.generic_visit(node)

    def visit_List(self, node: ast.List) -> None:
        self._visit_sequence_expression(node)

    def visit_Tuple(self, node: ast.Tuple) -> None:
        self._visit_sequence_expression(node)

    def visit_Set(self, node: ast.Set) -> None:
        self._visit_sequence_expression(node)

    def visit_Dict(self, node: ast.Dict) -> None:
        node_is_metadata_merge = self._is_metadata_merge_value(node)
        for key, value in zip(node.keys, node.values, strict=True):
            self._record_metadata_merge_key_violations(key)
            if key is not None or not node_is_metadata_merge:
                self._record_metadata_merge_key_violations(value)
        self.generic_visit(node)

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if not self._is_metadata_merge_value(node):
            self._record_metadata_merge_key_violations(node.left)
            self._record_metadata_merge_key_violations(node.right)
        self.generic_visit(node)

    def visit_UnaryOp(self, node: ast.UnaryOp) -> None:
        self._record_metadata_merge_key_violations(node.operand)
        self.generic_visit(node)

    def visit_Await(self, node: ast.Await) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Starred(self, node: ast.Starred) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_FormattedValue(self, node: ast.FormattedValue) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Slice(self, node: ast.Slice) -> None:
        self._record_metadata_merge_key_violations(node.lower)
        self._record_metadata_merge_key_violations(node.upper)
        self._record_metadata_merge_key_violations(node.step)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self._record_metadata_merge_key_violations(node.slice)
        if self._is_metadata_alias_value(node.value):
            self._add_violations(_metadata_key_expression_violations(self.path, node.slice))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        node_is_metadata_merge = self._is_metadata_merge_value(node)
        self._record_metadata_merge_key_violations(node)
        self._record_metadata_merge_key_violations(node.func)
        for index, argument in enumerate(node.args):
            if not node_is_metadata_merge or index > 0 or isinstance(argument, ast.Starred):
                self._record_metadata_merge_key_violations(argument)
        for keyword in node.keywords:
            if not (node_is_metadata_merge and keyword.arg is None):
                self._record_metadata_merge_key_violations(keyword.value)
        if isinstance(node.func, ast.Attribute) and self._is_metadata_alias_value(node.func.value):
            if node.func.attr in _METADATA_METHODS_WITH_KEY_ARGUMENTS and node.args:
                for key_arg in _static_call_argument_nodes(node.args, 0):
                    self._add_violations(_metadata_key_expression_violations(self.path, key_arg))
            if node.func.attr in _METADATA_METHODS_WITH_DICT_ARGUMENTS:
                for update_arg in _static_call_argument_nodes(node.args, 0):
                    self._record_metadata_dict_key_violations(update_arg)
                for keyword in node.keywords:
                    if keyword.arg is None:
                        self._record_metadata_dict_key_violations(keyword.value)
                        continue
                    key_name = _REGISTERED_METADATA_KEYS.get(keyword.arg)
                    if key_name is not None:
                        self._add_violation(_violation(self.path, keyword, key_name))
        self.visit(node.func)
        for argument in node.args:
            self.visit(argument)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_keyword(self, node: ast.keyword) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:
        self._record_metadata_merge_key_violations(node.test)
        self._record_metadata_merge_key_violations(node.msg)
        self.generic_visit(node)

    def visit_Raise(self, node: ast.Raise) -> None:
        self._record_metadata_merge_key_violations(node.exc)
        self._record_metadata_merge_key_violations(node.cause)
        self.generic_visit(node)

    def visit_Yield(self, node: ast.Yield) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_YieldFrom(self, node: ast.YieldFrom) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Compare(self, node: ast.Compare) -> None:
        self._record_metadata_merge_key_violations(node.left)
        for comparator in node.comparators:
            self._record_metadata_merge_key_violations(comparator)
        if (
            len(node.comparators) == 1
            and isinstance(node.ops[0], (ast.In, ast.NotIn))
            and self._is_metadata_alias_value(node.comparators[0])
        ):
            self._add_violations(_metadata_key_expression_violations(self.path, node.left))
        self.generic_visit(node)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            for name in _target_names(target):
                self._metadata_aliases.discard(name)
        self.generic_visit(node)

    def visit_If(self, node: ast.If) -> None:
        self._record_metadata_merge_key_violations(node.test)
        self.visit(node.test)
        base_aliases = set(self._metadata_aliases)
        body_aliases, body_falls_through = self._visit_branch_body(node.body, base_aliases)
        if node.orelse:
            orelse_aliases, orelse_falls_through = self._visit_branch_body(
                node.orelse, base_aliases
            )
        else:
            orelse_aliases = base_aliases
            orelse_falls_through = True
        exit_aliases: set[str] = set()
        if body_falls_through:
            exit_aliases.update(body_aliases)
        if orelse_falls_through:
            exit_aliases.update(orelse_aliases)
        self._replace_current_aliases(exit_aliases)

    def visit_For(self, node: ast.For) -> None:
        self._record_metadata_merge_key_violations(node.iter)
        self.visit(node.iter)
        base_aliases = set(self._metadata_aliases)
        self._discard_alias_target(node.target)
        body_aliases, _body_falls_through = self._visit_branch_body(
            node.body, set(self._metadata_aliases)
        )
        loop_exit_aliases = base_aliases | body_aliases
        orelse_aliases = (
            self._visit_branch_body(node.orelse, loop_exit_aliases)[0]
            if node.orelse
            else loop_exit_aliases
        )
        self._replace_current_aliases(loop_exit_aliases | orelse_aliases)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._record_metadata_merge_key_violations(node.iter)
        self.visit(node.iter)
        base_aliases = set(self._metadata_aliases)
        self._discard_alias_target(node.target)
        body_aliases, _body_falls_through = self._visit_branch_body(
            node.body, set(self._metadata_aliases)
        )
        loop_exit_aliases = base_aliases | body_aliases
        orelse_aliases = (
            self._visit_branch_body(node.orelse, loop_exit_aliases)[0]
            if node.orelse
            else loop_exit_aliases
        )
        self._replace_current_aliases(loop_exit_aliases | orelse_aliases)

    def visit_While(self, node: ast.While) -> None:
        self._record_metadata_merge_key_violations(node.test)
        self.visit(node.test)
        base_aliases = set(self._metadata_aliases)
        body_aliases, _body_falls_through = self._visit_branch_body(node.body, base_aliases)
        loop_exit_aliases = base_aliases | body_aliases
        orelse_aliases = (
            self._visit_branch_body(node.orelse, loop_exit_aliases)[0]
            if node.orelse
            else loop_exit_aliases
        )
        self._replace_current_aliases(loop_exit_aliases | orelse_aliases)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            self._record_metadata_merge_key_violations(item.context_expr)
            self.visit(item.context_expr)
        body_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(body_aliases)
        for item in node.items:
            self._discard_alias_target(item.optional_vars)
        body_falls_through = self._visit_current_scope_body(node.body)
        body_result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        self._replace_current_aliases(body_result_aliases if body_falls_through else set())

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        for item in node.items:
            self._record_metadata_merge_key_violations(item.context_expr)
            self.visit(item.context_expr)
        body_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(body_aliases)
        for item in node.items:
            self._discard_alias_target(item.optional_vars)
        body_falls_through = self._visit_current_scope_body(node.body)
        body_result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        self._replace_current_aliases(body_result_aliases if body_falls_through else set())

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self._record_metadata_merge_key_violations(node.type)
            self.visit(node.type)
        base_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(base_aliases)
        if node.name is not None:
            self._metadata_aliases.discard(node.name)
        self._visit_current_scope_body(node.body)
        result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        self._replace_current_aliases(base_aliases | result_aliases)

    def _visit_try_statement(self, node: ast.Try) -> None:
        base_aliases = set(self._metadata_aliases)
        body_aliases, body_falls_through = self._visit_branch_body(node.body, base_aliases)
        handler_start_aliases = base_aliases | body_aliases
        handler_results = [
            self._visit_except_handler_branch(handler, handler_start_aliases)
            for handler in node.handlers
        ]
        exit_aliases: set[str] = set()
        if body_falls_through:
            if node.orelse:
                orelse_aliases, orelse_falls_through = self._visit_branch_body(
                    node.orelse, body_aliases
                )
                if orelse_falls_through:
                    exit_aliases.update(orelse_aliases)
            else:
                exit_aliases.update(body_aliases)
        for aliases, falls_through in handler_results:
            if falls_through:
                exit_aliases.update(aliases)
        if node.finalbody:
            finalbody_scan_aliases = base_aliases | body_aliases
            for aliases, _falls_through in handler_results:
                finalbody_scan_aliases.update(aliases)
            if finalbody_scan_aliases == exit_aliases:
                exit_aliases, finalbody_falls_through = self._visit_branch_body(
                    node.finalbody, exit_aliases
                )
            else:
                self._visit_branch_body(node.finalbody, finalbody_scan_aliases)
                exit_aliases, finalbody_falls_through = (
                    self._visit_branch_body_state_only(node.finalbody, exit_aliases)
                    if exit_aliases
                    else (set(), True)
                )
            if not finalbody_falls_through:
                exit_aliases = set()
        self._replace_current_aliases(exit_aliases)

    def visit_Try(self, node: ast.Try) -> None:
        self._visit_try_statement(node)

    def visit_TryStar(self, node: ast.Try) -> None:
        self._visit_try_statement(node)

    def visit_Match(self, node: ast.Match) -> None:
        subject_is_metadata = self._is_metadata_alias_value(node.subject)
        self._record_metadata_merge_key_violations(node.subject)
        self.visit(node.subject)
        continuing_aliases = set(self._metadata_aliases)
        exit_aliases: set[str] = set()
        has_unmatched_path = True
        for case in node.cases:
            if subject_is_metadata:
                self._record_metadata_match_pattern_key_violations(case.pattern)
            names = _pattern_names(case.pattern)
            pattern_is_exhaustive = _pattern_is_exhaustive(case.pattern)
            aliases = set(continuing_aliases)
            aliases.difference_update(names)
            if subject_is_metadata:
                aliases.update(_metadata_match_pattern_alias_names(case.pattern))
            self._metadata_alias_scopes.append(aliases)
            if case.guard is not None:
                self._record_metadata_merge_key_violations(case.guard)
                self.visit(case.guard)
            guard_aliases = set(self._metadata_aliases)
            falls_through = self._visit_current_scope_body(case.body)
            if falls_through:
                exit_aliases.update(self._metadata_aliases)
            self._metadata_alias_scopes.pop()
            if case.guard is not None:
                if pattern_is_exhaustive:
                    continuing_aliases = guard_aliases
                else:
                    continuing_aliases.update(guard_aliases)
            if case.guard is None and pattern_is_exhaustive:
                has_unmatched_path = False
                break
        if has_unmatched_path:
            exit_aliases.update(continuing_aliases)
        self._replace_current_aliases(exit_aliases)

    def _record_metadata_match_pattern_key_violations(self, pattern: ast.pattern) -> None:
        if isinstance(pattern, ast.MatchMapping):
            for key in pattern.keys:
                self._add_violations(_metadata_key_expression_violations(self.path, key))
            return
        if isinstance(pattern, ast.MatchAs) and pattern.pattern is not None:
            self._record_metadata_match_pattern_key_violations(pattern.pattern)
            return
        if isinstance(pattern, ast.MatchOr):
            for child_pattern in pattern.patterns:
                self._record_metadata_match_pattern_key_violations(child_pattern)

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
        is_metadata_alias = self._is_metadata_alias_value(node.value)
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
        self._record_metadata_merge_key_violations(first_generator.iter)
        self.visit(first_generator.iter)

        named_expr_target_scope_index = (
            self._named_expr_target_scope_indexes[-1]
            if self._named_expr_target_scope_indexes
            else len(self._metadata_alias_scopes) - 1
        )
        self._metadata_alias_scopes.append(self._nested_function_base_aliases())
        self._named_expr_target_scope_indexes.append(named_expr_target_scope_index)
        self._discard_alias_target(first_generator.target)
        for condition in first_generator.ifs:
            self._record_metadata_merge_key_violations(condition)
            self.visit(condition)
        for generator in remaining_generators:
            self._record_metadata_merge_key_violations(generator.iter)
            self.visit(generator.iter)
            self._discard_alias_target(generator.target)
            for condition in generator.ifs:
                self._record_metadata_merge_key_violations(condition)
                self.visit(condition)
        for expression in body_expressions:
            self._record_metadata_merge_key_violations(expression)
            self.visit(expression)
        self._named_expr_target_scope_indexes.pop()
        self._metadata_alias_scopes.pop()


def metadata_key_violations(path: Path) -> list[str]:
    with tokenize.open(str(path)) as source_file:
        source = source_file.read()
    tree = ast.parse(source, filename=str(path))
    visitor = _MetadataKeyVisitor(path)
    visitor.visit(tree)
    return visitor.violations


def _metadata_dict_key_violations(path: Path, node: ast.AST | None) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.NamedExpr):
        return _metadata_dict_key_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_dict_key_violations(path, node.body),
            *_metadata_dict_key_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        boolop_violations: list[str] = []
        for value in node.values:
            boolop_violations.extend(_metadata_dict_key_violations(path, value))
        return boolop_violations
    if isinstance(node, ast.DictComp):
        return _metadata_key_expression_violations(path, node.key)
    if isinstance(node, ast.List | ast.Tuple | ast.Set):
        return _metadata_pair_sequence_violations(path, node)
    if isinstance(node, ast.ListComp | ast.SetComp | ast.GeneratorExp):
        return _metadata_pair_element_violations(path, node.elt)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return [
            *_metadata_dict_key_violations(path, node.left),
            *_metadata_dict_key_violations(path, node.right),
        ]
    if isinstance(node, ast.Call):
        if (
            isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "dict"
            and node.func.attr == "fromkeys"
        ):
            fromkeys_violations: list[str] = []
            for keys_arg in _static_call_argument_nodes(node.args, 0):
                fromkeys_violations.extend(_metadata_key_sequence_violations(path, keys_arg))
            return fromkeys_violations
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "items"
            and not node.args
            and not node.keywords
        ):
            return _metadata_dict_key_violations(path, node.func.value)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "copy"
            and not node.args
            and not node.keywords
        ):
            return _metadata_dict_key_violations(path, node.func.value)
        if isinstance(node.func, ast.Name):
            if node.func.id == "dict":
                dict_call_violations: list[str] = []
                for update_arg in _static_call_argument_nodes(node.args, 0):
                    dict_call_violations.extend(_metadata_dict_key_violations(path, update_arg))
                dict_call_violations.extend(_metadata_keyword_violations(path, node.keywords))
                return dict_call_violations
            if node.func.id == "zip":
                return _metadata_zip_key_violations(path, node)
            if node.func.id in _SEQUENCE_WRAPPER_CALLS:
                wrapper_violations: list[str] = []
                for update_arg in _static_call_argument_nodes(node.args, 0):
                    wrapper_violations.extend(_metadata_dict_key_violations(path, update_arg))
                return wrapper_violations
    if not isinstance(node, ast.Dict):
        return []
    violations: list[str] = []
    for key, value in zip(node.keys, node.values, strict=True):
        if key is None:
            violations.extend(_metadata_dict_key_violations(path, value))
            continue
        violations.extend(_metadata_key_expression_violations(path, key))
    return violations


def _metadata_pair_sequence_violations(
    path: Path, node: ast.List | ast.Tuple | ast.Set
) -> list[str]:
    violations: list[str] = []
    for item in node.elts:
        if isinstance(item, ast.Starred):
            violations.extend(_metadata_pair_iterable_violations(path, item.value))
            continue
        violations.extend(_metadata_pair_element_violations(path, item))
    return violations


def _metadata_pair_element_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_pair_element_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_pair_element_violations(path, node.body),
            *_metadata_pair_element_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_pair_element_violations(path, value))
        return violations
    if not isinstance(node, ast.List | ast.Tuple) or len(node.elts) != _METADATA_PAIR_LENGTH:
        return []
    return _metadata_key_expression_violations(path, node.elts[0])


def _metadata_pair_iterable_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_pair_iterable_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_pair_iterable_violations(path, node.body),
            *_metadata_pair_iterable_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        boolop_violations: list[str] = []
        for value in node.values:
            boolop_violations.extend(_metadata_pair_iterable_violations(path, value))
        return boolop_violations
    if isinstance(node, ast.List | ast.Tuple | ast.Set):
        return _metadata_pair_sequence_violations(path, node)
    if isinstance(node, ast.ListComp | ast.SetComp | ast.GeneratorExp):
        return _metadata_pair_element_violations(path, node.elt)
    if isinstance(node, ast.Call):
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "items"
            and not node.args
            and not node.keywords
        ):
            return _metadata_dict_key_violations(path, node.func.value)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "copy"
            and not node.args
            and not node.keywords
        ):
            return _metadata_pair_iterable_violations(path, node.func.value)
        if isinstance(node.func, ast.Name):
            if node.func.id == "zip":
                return _metadata_zip_key_violations(path, node)
            if node.func.id in _SEQUENCE_WRAPPER_CALLS:
                violations: list[str] = []
                for update_arg in _static_call_argument_nodes(node.args, 0):
                    violations.extend(_metadata_pair_iterable_violations(path, update_arg))
                return violations
    return []


def _metadata_key_sequence_violations(path: Path, node: ast.AST | None) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.NamedExpr):
        return _metadata_key_sequence_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_key_sequence_violations(path, node.body),
            *_metadata_key_sequence_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        sequence_violations: list[str] = []
        for value in node.values:
            sequence_violations.extend(_metadata_key_sequence_violations(path, value))
        return sequence_violations
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return [
            *_metadata_key_sequence_violations(path, node.left),
            *_metadata_key_sequence_violations(path, node.right),
        ]
    if isinstance(node, ast.ListComp | ast.SetComp | ast.GeneratorExp):
        return _metadata_key_expression_violations(path, node.elt)
    if isinstance(node, ast.DictComp):
        return _metadata_key_expression_violations(path, node.key)
    if isinstance(node, ast.Dict):
        dict_key_violations: list[str] = []
        for key, value in zip(node.keys, node.values, strict=True):
            if key is None:
                dict_key_violations.extend(_metadata_key_sequence_violations(path, value))
                continue
            dict_key_violations.extend(_metadata_key_expression_violations(path, key))
        return dict_key_violations
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "keys"
        and not node.args
        and not node.keywords
    ):
        return _metadata_key_sequence_violations(path, node.func.value)
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "copy"
        and not node.args
        and not node.keywords
    ):
        return _metadata_key_sequence_violations(path, node.func.value)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id == "dict":
            return _metadata_dict_key_violations(path, node)
        if node.func.id in _SEQUENCE_WRAPPER_CALLS:
            wrapper_violations: list[str] = []
            for keys_arg in _static_call_argument_nodes(node.args, 0):
                wrapper_violations.extend(_metadata_key_sequence_violations(path, keys_arg))
            return wrapper_violations
    if not isinstance(node, ast.List | ast.Tuple | ast.Set):
        return []
    violations: list[str] = []
    for element in node.elts:
        if isinstance(element, ast.Starred):
            violations.extend(_metadata_key_sequence_violations(path, element.value))
            continue
        violations.extend(_metadata_key_expression_violations(path, element))
    return violations


def _metadata_zip_key_violations(path: Path, node: ast.Call) -> list[str]:
    violations: list[str] = []
    for keys_arg in _static_call_argument_nodes(node.args, 0):
        violations.extend(_metadata_key_sequence_violations(path, keys_arg))
    return violations


def _metadata_key_expression_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_key_expression_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_key_expression_violations(path, node.body),
            *_metadata_key_expression_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_key_expression_violations(path, value))
        return violations
    key_name = _registered_key_name(node)
    if key_name is None:
        return []
    return [_violation(path, node, key_name)]


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


def duplicate_registered_metadata_keys() -> dict[str, list[str]]:
    names_by_value: dict[str, list[str]] = {}
    for name, value in vars(metadata_keys).items():
        if name.isupper() and isinstance(value, str):
            names_by_value.setdefault(value, []).append(name)
    return {value: names for value, names in sorted(names_by_value.items()) if len(names) > 1}


def repository_metadata_key_violations() -> list[str]:
    return [violation for path in _python_files() for violation in metadata_key_violations(path)]


def main() -> int:
    messages: list[str] = []
    for value, names in duplicate_registered_metadata_keys().items():
        messages.append(
            f"src/flow_metadata_keys.py: duplicate metadata key {value!r}: {', '.join(names)}"
        )
    messages.extend(repository_metadata_key_violations())
    if not messages:
        return 0
    sys.stdout.write("\n".join(messages) + "\n")
    return 1
