"""AST visitor for flow metadata alias and key usage analysis."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

from flow_metadata_linter.ast_helpers import (
    _argument_annotations,
    _argument_names,
    _expression_bound_names,
    _pattern_is_exhaustive,
    _pattern_names,
    _scope_bound_name_visitor,
    _statement_can_fall_through,
    _static_call_argument_nodes,
    _target_names,
    _type_alias_target_names,
    _type_alias_value,
    _type_param_names,
    _type_params,
)
from flow_metadata_linter.metadata_rules import (
    _is_metadata_attribute,
    _metadata_dict_key_violations,
    _metadata_key_expression_violations,
    _violation,
)
from flow_metadata_linter.registry import REGISTERED_METADATA_KEYS as _REGISTERED_METADATA_KEYS

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


@dataclass
class _ExceptionAliasState:
    """Whether exception paths exist and aliases that may hold on those paths."""

    may_raise: bool = False
    aliases: set[str] = field(default_factory=set)

    def record(self, aliases: set[str]) -> None:
        self.may_raise = True
        self.aliases.update(aliases)

    def merge(self, other: _ExceptionAliasState) -> None:
        if other.may_raise:
            self.record(other.aliases)


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


class _MetadataKeyVisitor(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[str] = []
        self._violation_messages: set[str] = set()
        self._metadata_alias_scopes: list[set[str]] = [set()]
        self._exception_alias_scopes: list[_ExceptionAliasState] = []
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

    def _record_exception_aliases(self, aliases: set[str] | None = None) -> None:
        if not self._exception_alias_scopes:
            return
        self._exception_alias_scopes[-1].record(
            self._metadata_aliases if aliases is None else aliases
        )

    def _record_exception_state(self, state: _ExceptionAliasState) -> None:
        if state.may_raise:
            self._record_exception_aliases(state.aliases)

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

    def _visit_branch_body_capturing_exceptions(
        self, body: list[ast.stmt], aliases: set[str]
    ) -> tuple[set[str], bool, _ExceptionAliasState]:
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        result_aliases, falls_through = self._visit_branch_body(body, aliases)
        self._exception_alias_scopes.pop()
        return result_aliases, falls_through, exception_state

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

    def _visit_except_handler_branch_capturing_exceptions(
        self, handler: ast.ExceptHandler, aliases: set[str]
    ) -> tuple[set[str], bool, _ExceptionAliasState]:
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        result_aliases, falls_through = self._visit_except_handler_branch(handler, aliases)
        self._exception_alias_scopes.pop()
        if handler.name is not None:
            exception_state.aliases.discard(handler.name)
        return result_aliases, falls_through, exception_state

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

    def _visit_function_definition(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
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
        self._exception_alias_scopes.append(_ExceptionAliasState())
        self._visit_scoped_body(node.body, shadowed_names, metadata_defaults, body_base_aliases)
        self._exception_alias_scopes.pop()
        self._metadata_aliases.discard(node.name)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function_definition(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function_definition(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        self._exception_alias_scopes.append(_ExceptionAliasState())
        self._visit_scoped_expression(
            node.body,
            (_argument_names(node.args) | _expression_bound_names(node.body)) - metadata_defaults,
            metadata_defaults,
            self._nested_function_base_aliases(),
        )
        self._exception_alias_scopes.pop()

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
        class_failure_aliases = set(self._metadata_aliases)
        class_exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(class_exception_state)
        self._class_nested_scope_alias_scopes.append(outer_aliases)
        self._visit_scoped_body(node.body, base_aliases=class_body_aliases)
        self._class_nested_scope_alias_scopes.pop()
        self._exception_alias_scopes.pop()
        if class_exception_state.may_raise:
            outer_visible_names = (
                (class_failure_aliases | class_exception_state.aliases)
                - class_body_bound_names
                - class_body_global_names
                - type_param_names
            )
            class_failure_aliases.difference_update(outer_visible_names)
            class_failure_aliases.update(class_exception_state.aliases & outer_visible_names)
            self._record_exception_aliases(class_failure_aliases)
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
        self._record_exception_aliases()

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

    def _visit_with_statement(self, node: ast.With | ast.AsyncWith) -> None:
        for item in node.items:
            self._record_metadata_merge_key_violations(item.context_expr)
            self.visit(item.context_expr)
            self._discard_alias_target(item.optional_vars)
        body_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(body_aliases)
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        body_falls_through = self._visit_current_scope_body(node.body)
        self._exception_alias_scopes.pop()
        body_result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        exit_aliases = body_result_aliases if body_falls_through else set()
        exit_aliases.update(exception_state.aliases)
        self._replace_current_aliases(exit_aliases)
        self._record_exception_state(exception_state)

    def visit_With(self, node: ast.With) -> None:
        self._visit_with_statement(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        self._visit_with_statement(node)

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
        body_aliases, body_falls_through, body_exception_state = (
            self._visit_branch_body_capturing_exceptions(node.body, base_aliases)
        )
        handler_start_aliases = base_aliases | body_aliases | body_exception_state.aliases
        handler_results = [
            self._visit_except_handler_branch_capturing_exceptions(handler, handler_start_aliases)
            for handler in node.handlers
        ]
        exit_aliases: set[str] = set()
        has_normal_exit = False
        exception_state = _ExceptionAliasState()
        if not any(handler.type is None for handler in node.handlers):
            exception_state.merge(body_exception_state)
        if body_falls_through:
            if node.orelse:
                orelse_aliases, orelse_falls_through, orelse_exception_state = (
                    self._visit_branch_body_capturing_exceptions(node.orelse, body_aliases)
                )
                exception_state.merge(orelse_exception_state)
                if orelse_falls_through:
                    exit_aliases.update(orelse_aliases)
                    has_normal_exit = True
            else:
                exit_aliases.update(body_aliases)
                has_normal_exit = True
        for aliases, falls_through, handler_exception_state in handler_results:
            exception_state.merge(handler_exception_state)
            if falls_through:
                exit_aliases.update(aliases)
                has_normal_exit = True
        if node.finalbody:
            finalbody_scan_aliases = (
                base_aliases
                | body_aliases
                | body_exception_state.aliases
                | exit_aliases
                | exception_state.aliases
            )
            for aliases, _falls_through, handler_exception_state in handler_results:
                finalbody_scan_aliases.update(aliases)
                finalbody_scan_aliases.update(handler_exception_state.aliases)
            finalbody_exception_state = _ExceptionAliasState()
            self._exception_alias_scopes.append(finalbody_exception_state)
            finalbody_scan_result, finalbody_falls_through = self._visit_branch_body(
                node.finalbody, finalbody_scan_aliases
            )
            if finalbody_scan_aliases == exit_aliases:
                exit_aliases = finalbody_scan_result
            elif has_normal_exit:
                exit_aliases = self._visit_branch_body_state_only(node.finalbody, exit_aliases)[0]
            if exception_state.may_raise and finalbody_falls_through:
                exception_state.aliases = (
                    finalbody_scan_result
                    if finalbody_scan_aliases == exception_state.aliases
                    else self._visit_branch_body_state_only(
                        node.finalbody, exception_state.aliases
                    )[0]
                )
            else:
                exception_state = _ExceptionAliasState()
            self._exception_alias_scopes.pop()
            if not finalbody_falls_through:
                exit_aliases = set()
            exception_state.merge(finalbody_exception_state)
        self._replace_current_aliases(exit_aliases)
        self._record_exception_state(exception_state)

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
