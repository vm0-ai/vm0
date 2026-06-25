"""Tests for the shared flow metadata key registry contract."""

import ast
from pathlib import Path
from typing import TypeGuard

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
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword)

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
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
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


def _scope_bound_names(body: list[ast.stmt]) -> set[str]:
    visitor = _ScopeBoundNameVisitor()
    for statement in body:
        visitor.visit(statement)
    return visitor.local_names


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
        self._metadata_alias_scopes: list[set[str]] = [set()]
        self._class_nested_scope_alias_scopes: list[set[str]] = []
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
        self.violations.extend(self._metadata_merge_key_violations(node))
        self.visit(node)

    def _replace_current_aliases(self, aliases: set[str]) -> None:
        self._metadata_aliases.clear()
        self._metadata_aliases.update(aliases)

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
        result = self._visit_branch_body(body, aliases)
        del self.violations[violation_count:]
        return result

    def _visit_except_handler_branch(
        self, handler: ast.ExceptHandler, aliases: set[str]
    ) -> tuple[set[str], bool]:
        self._metadata_alias_scopes.append(set(aliases))
        if handler.type is not None:
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
        self.visit(expression)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        shadowed_names = (
            (_argument_names(node.args) | _scope_bound_names(node.body)) - metadata_defaults
        ) | {node.name}
        self._visit_scoped_body(
            node.body, shadowed_names, metadata_defaults, self._nested_function_base_aliases()
        )
        self._metadata_aliases.discard(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        shadowed_names = (
            (_argument_names(node.args) | _scope_bound_names(node.body)) - metadata_defaults
        ) | {node.name}
        self._visit_scoped_body(
            node.body, shadowed_names, metadata_defaults, self._nested_function_base_aliases()
        )
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
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword)
        outer_aliases = set(self._metadata_aliases)
        class_body_aliases = set(outer_aliases)
        class_body_aliases.difference_update(_scope_bound_names(node.body))
        class_body_aliases.update(self._metadata_alias_scopes[0])
        self._class_nested_scope_alias_scopes.append(outer_aliases)
        self._visit_scoped_body(node.body, base_aliases=class_body_aliases)
        self._class_nested_scope_alias_scopes.pop()
        self._metadata_aliases.discard(node.name)

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(_is_metadata_attribute(target) for target in node.targets):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        else:
            self.violations.extend(self._metadata_merge_key_violations(node.value))
        self.visit(node.value)
        for target in node.targets:
            self.visit(target)
        self._update_aliases_from_assign(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if _is_metadata_attribute(node.target):
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        elif node.value is not None:
            self.violations.extend(self._metadata_merge_key_violations(node.value))
        if node.value is not None:
            self.visit(node.value)
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
            self.violations.extend(_metadata_dict_key_violations(self.path, node.value))
        elif value_is_metadata_merge:
            self.violations.extend(self._metadata_merge_key_violations(node.value))
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
            self.violations.extend(self._metadata_merge_key_violations(node.value))
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

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self._is_metadata_alias_value(node.value):
            key_name = _registered_key_name(node.slice)
            if key_name is not None:
                self.violations.append(_violation(self.path, node, key_name))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Attribute) and self._is_metadata_alias_value(node.func.value):
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
            and self._is_metadata_alias_value(node.comparators[0])
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

    def visit_If(self, node: ast.If) -> None:
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
        self.visit(node.subject)
        continuing_aliases = set(self._metadata_aliases)
        exit_aliases: set[str] = set()
        has_unmatched_path = True
        for case in node.cases:
            names = _pattern_names(case.pattern)
            pattern_is_exhaustive = _pattern_is_exhaustive(case.pattern)
            aliases = set(continuing_aliases)
            aliases.difference_update(names)
            self._metadata_alias_scopes.append(aliases)
            if case.guard is not None:
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
flow.metadata = {"vm_run_id": "run-1"} if condition else {}
flow.metadata.update({"vm_run_id": "run-1"} if condition else {})
flow.metadata.update(fallback_update or {"vm_run_id": "run-1"})
flow.metadata.update([("vm_run_id", "run-1")] if condition else [])
flow.metadata.update((named_update := {"vm_run_id": "run-1"}))
flow.metadata = {**({"vm_run_id": "run-1"} if condition else {})}
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
def local_function_assigns_metadata():
    local_function_meta = flow.metadata
    local_function_meta["vm_run_id"] = "run-1"
class ClassBodyAssignsMetadata:
    class_body_meta = flow.metadata
    class_body_meta["vm_run_id"] = "run-1"
def class_body_reads_closure_metadata():
    class_closure_meta = flow.metadata
    class ReadsClosure:
        class_closure_meta["vm_run_id"] = "run-1"
def class_method_reads_outer_metadata():
    method_outer_meta = flow.metadata
    class MethodReadsOuter:
        method_outer_meta = {}
        def method(self):
            method_outer_meta["vm_run_id"] = "run-1"
annotated_meta = flow.metadata
annotated_meta: dict[str, object]
annotated_meta["auth_url_rewrite"] = True
annotated_meta: str = annotated_meta["auth_url_rewrite"]
reassigned_meta = flow.metadata
reassigned_meta = reassigned_meta["connector_diagnostic_env_names"]
(named_expr_reassigned_meta := flow.metadata)
(named_expr_reassigned_meta := named_expr_reassigned_meta["firewall_error"])
merged_meta = flow.metadata | {"firewall_base": "https://api.example.com"}
merged_meta = {**merged_meta, "firewall_api_id": "run-1:0"}
merged_meta = dict(merged_meta, firewall_action="ALLOW")
kwargs_merged_meta = dict(**flow.metadata, vm_run_id="run-1")
kwargs_alias_meta = dict(**flow.metadata)
kwargs_alias_meta["vm_run_id"] = "run-1"
conditional_expr_meta = flow.metadata if condition else {}
conditional_expr_meta["vm_run_id"] = "run-1"
bool_expr_meta = fallback_meta or flow.metadata
bool_expr_meta["firewall_name"] = "github"
conditional_merge_meta = (flow.metadata | {"firewall_action": "ALLOW"}) if condition else {}
conditional_rhs_merge_meta = flow.metadata | ({"firewall_action": "ALLOW"} if condition else {})
copy_meta = flow.metadata.copy()
copy_meta["vm_run_id"] = "run-1"
(flow.metadata if condition else {})["firewall_base"] = "https://api.example.com"
(flow.metadata if condition else {}).get("firewall_action")
"firewall_name" in (flow.metadata if condition else {})
(merged_named_expr_meta := flow.metadata | {"firewall_name": "github"})
(inline_conditional_meta := flow.metadata if condition else {})["vm_run_id"] = "run-1"
(inline_meta := flow.metadata)["connector_diagnostic_type"] = "github"
(call_meta := flow.metadata).get("connector_diagnostic_reason")
def function_default_meta(default_meta=flow.metadata):
    default_meta["vm_run_id"] = "run-1"
lambda_default_meta = lambda default_meta=flow.metadata: default_meta["vm_network_log_path"]
if conditional_meta := flow.metadata:
    conditional_meta["connector_diagnostic_base"] = "https://api.example.com"
branch_meta = flow.metadata
if condition:
    branch_meta = {}
branch_meta["vm_proxy_log_path"] = "proxy.jsonl"
while_meta = flow.metadata
while condition:
    while_meta = {}
while_meta["capture_body"] = True
loop_meta = flow.metadata
for loop_meta in rows:
    pass
loop_meta["vm_sandbox_token"] = "sandbox"
try_meta = flow.metadata
try:
    try_meta = {}
except Exception:
    pass
try_meta["original_url"] = "https://api.example.com"
except_meta = flow.metadata
try:
    pass
except Exception as except_meta:
    pass
except_meta["suppress_request_body_capture"] = True
except_star_meta = flow.metadata
try:
    pass
except* Exception as except_star_meta:
    pass
except_star_meta["firewall_error"] = "auth_failed"
break_exit_meta = {}
for item in rows:
    break_exit_meta = flow.metadata
    break
break_exit_meta["vm_run_id"] = "run-1"
def finalbody_alias_after_return():
    finalbody_meta = flow.metadata
    try:
        return None
    finally:
        finalbody_meta["vm_run_id"] = "run-1"
aug_merged_meta = {}
aug_merged_meta |= flow.metadata | {"firewall_action": "ALLOW"}
aug_merged_meta["firewall_name"] = "github"
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
match payload:
    case {"payload": payload}:
        outer_meta["_model_json_usage_finalized"] = True
match_alias_after_case = {}
match match_payload:
    case {"metadata": raw_match_metadata}:
        match_alias_after_case = flow.metadata
    case _:
        pass
match_alias_after_case["vm_run_id"] = "run-1"
match match_payload:
    case _ if (guard_case_meta := flow.metadata) and False:
        pass
    case _:
        guard_case_meta["vm_run_id"] = "run-1"
"""
    )

    violations = _metadata_key_violations(source_path)

    assert len(violations) == 77
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
external_meta_value = flow.metadata
payload = {"vm_run_id": "external", "metadata": external_meta_value}
meta = flow.metadata
meta = {"vm_run_id": "external payload"}
both_branch_meta = flow.metadata
if condition:
    both_branch_meta = {}
else:
    both_branch_meta = {}
value = both_branch_meta["vm_run_id"]
external_aug_meta = {}
external_aug_meta |= {"vm_run_id": "external"}
value = external_aug_meta["vm_run_id"]
external_keyword_meta = dict(metadata=flow.metadata, vm_run_id="external")
value = external_keyword_meta["vm_run_id"]
external_union_meta = {"metadata": flow.metadata} | {"vm_run_id": "external"}
value = external_union_meta["vm_run_id"]
external_unpack_meta = {**{"metadata": flow.metadata}, "vm_run_id": "external"}
value = external_unpack_meta["vm_run_id"]
external_positional_dict_meta = dict({"metadata": flow.metadata, "vm_run_id": "external"})
value = external_positional_dict_meta["vm_run_id"]
external_unpack_dict_meta = dict(**{"metadata": flow.metadata, "vm_run_id": "external"})
value = external_unpack_dict_meta["vm_run_id"]
external_conditional_meta = {"vm_run_id": "external"} if condition else {}
value = external_conditional_meta["vm_run_id"]
external_bool_meta = fallback_meta or {"vm_run_id": "external"}
value = external_bool_meta["vm_run_id"]
external_copy_meta = {"vm_run_id": "external"}.copy()
value = external_copy_meta["vm_run_id"]
value = ({"vm_run_id": "external"} if condition else {}).get("vm_run_id")
value = "vm_run_id" in ({"vm_run_id": "external"} if condition else {})
def terminal_if_rebinds_to_external(condition):
    terminal_if_meta = flow.metadata
    if condition:
        return None
    else:
        terminal_if_meta = {}
    return terminal_if_meta["vm_run_id"]
def terminal_raise_rebinds_to_external(condition):
    terminal_raise_meta = flow.metadata
    if condition:
        raise RuntimeError
    else:
        terminal_raise_meta = {}
    return terminal_raise_meta["vm_run_id"]
def terminal_try_handler_rebinds_to_external():
    terminal_try_meta = flow.metadata
    try:
        return None
    except Exception:
        terminal_try_meta = {}
    return terminal_try_meta["vm_run_id"]
def partial_return_finalbody_rebinds_to_external(condition):
    partial_finalbody_meta = flow.metadata
    try:
        if condition:
            return None
    finally:
        partial_finalbody_meta = {}
    return partial_finalbody_meta["vm_run_id"]
def terminal_match_rebinds_to_external(match_payload):
    terminal_match_meta = flow.metadata
    match match_payload:
        case {"return": True}:
            return None
        case _:
            terminal_match_meta = {}
    return terminal_match_meta["vm_run_id"]
def guarded_capture_rebinds_to_external(match_payload):
    guarded_capture_meta = flow.metadata
    match match_payload:
        case guarded_capture_meta if False:
            pass
    return guarded_capture_meta["vm_run_id"]
def guarded_as_capture_rebinds_to_external(match_payload):
    guarded_as_meta = flow.metadata
    match match_payload:
        case _ as guarded_as_meta if False:
            pass
    return guarded_as_meta["vm_run_id"]
def with_target_rebinds_to_external():
    with_target_meta = flow.metadata
    with context() as with_target_meta:
        pass
    return with_target_meta["vm_run_id"]
async def async_with_target_rebinds_to_external():
    async_with_target_meta = flow.metadata
    async with context() as async_with_target_meta:
        pass
    return async_with_target_meta["vm_run_id"]
def break_skips_unreachable_metadata_access():
    for item in rows:
        unreachable_break_meta = flow.metadata
        break
        unreachable_break_meta["vm_run_id"]
def continue_skips_unreachable_metadata_access():
    for item in rows:
        unreachable_continue_meta = flow.metadata
        continue
        unreachable_continue_meta["vm_run_id"]
late_assignment_meta = flow.metadata
def late_assignment_local_shadow():
    value = late_assignment_meta["vm_run_id"]
    late_assignment_meta = {}
late_import_meta = flow.metadata
def late_import_local_shadow():
    value = late_import_meta["vm_run_id"]
    import json as late_import_meta
late_loop_meta = flow.metadata
def late_loop_local_shadow():
    value = late_loop_meta["vm_run_id"]
    for late_loop_meta in rows:
        pass
late_delete_meta = flow.metadata
def late_delete_local_shadow():
    value = late_delete_meta["vm_run_id"]
    del late_delete_meta
late_match_meta = flow.metadata
def late_match_local_shadow(match_payload):
    value = late_match_meta["vm_run_id"]
    match match_payload:
        case late_match_meta:
            pass
lambda_shadow_meta = flow.metadata
fn = lambda: lambda_shadow_meta["vm_run_id"] if (lambda_shadow_meta := {}) else None
def class_body_late_binding_shadow():
    class_shadow_meta = flow.metadata
    class ShadowsClosure:
        value = class_shadow_meta["vm_run_id"]
        class_shadow_meta = {}
class MethodDoesNotSeeClassAlias:
    method_class_meta = flow.metadata
    def method(self):
        method_class_meta["vm_run_id"]
class ComprehensionDoesNotSeeClassAlias:
    comp_class_meta = flow.metadata
    values = [comp_class_meta["vm_run_id"] for item in rows]
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
*starred_meta, = flow.metadata
value = starred_meta["vm_run_id"]
fn = lambda meta: meta["vm_run_id"]
values = [meta["vm_run_id"] for meta in [{"vm_run_id": "external"}]]
values = {meta["vm_run_id"] for meta in [{"vm_run_id": "external"}]}
values = {meta["vm_run_id"]: 1 for meta in [{"vm_run_id": "external"}]}
values = tuple(meta["vm_run_id"] for meta in [{"vm_run_id": "external"}])
[(lambda: (lambda_local_meta := flow.metadata))() for item in rows]
value = lambda_local_meta["vm_run_id"]
values = [(meta := {"vm_run_id": "external"}) for item in rows]
value = meta["vm_run_id"]
match payload:
    case {"meta": match_meta, **match_rest} if match_rest["vm_run_id"]:
        value = match_meta["vm_run_id"]
    case Item(meta=class_meta):
        value = class_meta["vm_run_id"]
    case [sequence_meta, *sequence_tail]:
        value = sequence_meta["vm_run_id"]
        value = sequence_tail["vm_run_id"]
    case meta:
        value = meta["vm_run_id"]
value = match_meta["vm_run_id"]
try:
    pass
except Exception as meta:
    value = meta["vm_run_id"]
"""
    )

    assert _metadata_key_violations(source_path) == []
