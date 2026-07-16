"""Generic Python AST helpers for flow metadata key linting."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import TypeGuard


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


def _pattern_is_exhaustive(pattern: ast.pattern) -> bool:
    if isinstance(pattern, ast.MatchAs):
        return pattern.pattern is None or _pattern_is_exhaustive(pattern.pattern)
    if isinstance(pattern, ast.MatchOr):
        return any(_pattern_is_exhaustive(child_pattern) for child_pattern in pattern.patterns)
    return False


@dataclass(frozen=True)
class _FlowSummary:
    """Syntactic exits used by reachability; ``raises`` covers explicit ``raise`` only."""

    falls_through: bool
    raises: bool


def _body_flow(body: list[ast.stmt]) -> _FlowSummary:
    falls_through = True
    raises = False
    for statement in body:
        if not falls_through:
            break
        statement_flow = _statement_flow(statement)
        falls_through = statement_flow.falls_through
        raises = raises or statement_flow.raises
    return _FlowSummary(falls_through=falls_through, raises=raises)


def _is_try_statement(statement: ast.stmt) -> TypeGuard[ast.Try]:
    return isinstance(statement, ast.Try) or statement.__class__.__name__ == "TryStar"


def _try_statement_flow(statement: ast.Try) -> _FlowSummary:
    body_flow = _body_flow(statement.body)
    normal_path_falls_through = body_flow.falls_through
    raises = body_flow.raises and not any(handler.type is None for handler in statement.handlers)
    if normal_path_falls_through and statement.orelse:
        orelse_flow = _body_flow(statement.orelse)
        normal_path_falls_through = orelse_flow.falls_through
        raises = raises or orelse_flow.raises
    handler_flows = [_body_flow(handler.body) for handler in statement.handlers]
    falls_through = normal_path_falls_through or any(flow.falls_through for flow in handler_flows)
    raises = raises or any(flow.raises for flow in handler_flows)
    if not statement.finalbody:
        return _FlowSummary(falls_through=falls_through, raises=raises)
    finalbody_flow = _body_flow(statement.finalbody)
    return _FlowSummary(
        falls_through=falls_through and finalbody_flow.falls_through,
        raises=finalbody_flow.raises or (raises and finalbody_flow.falls_through),
    )


def _statement_flow(statement: ast.stmt) -> _FlowSummary:
    if isinstance(statement, ast.Raise):
        return _FlowSummary(falls_through=False, raises=True)
    if isinstance(statement, (ast.Return, ast.Break, ast.Continue)):
        return _FlowSummary(falls_through=False, raises=False)
    if isinstance(statement, ast.If):
        body_flow = _body_flow(statement.body)
        orelse_flow = (
            _body_flow(statement.orelse)
            if statement.orelse
            else _FlowSummary(falls_through=True, raises=False)
        )
        return _FlowSummary(
            falls_through=body_flow.falls_through or orelse_flow.falls_through,
            raises=body_flow.raises or orelse_flow.raises,
        )
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        body_flow = _body_flow(statement.body)
        return _FlowSummary(
            falls_through=body_flow.falls_through or body_flow.raises,
            raises=body_flow.raises,
        )
    if _is_try_statement(statement):
        return _try_statement_flow(statement)
    if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        body_flow = _body_flow(statement.body)
        orelse_flow = _body_flow(statement.orelse)
        return _FlowSummary(
            falls_through=True,
            raises=body_flow.raises or orelse_flow.raises,
        )
    if isinstance(statement, ast.Match):
        case_falls_through = False
        has_unmatched_path = True
        raises = False
        for case in statement.cases:
            case_flow = _body_flow(case.body)
            case_falls_through = case_falls_through or case_flow.falls_through
            raises = raises or case_flow.raises
            if case.guard is None and _pattern_is_exhaustive(case.pattern):
                has_unmatched_path = False
                break
        return _FlowSummary(
            falls_through=has_unmatched_path or case_falls_through,
            raises=raises,
        )
    if isinstance(statement, ast.ClassDef):
        return _body_flow(statement.body)
    return _FlowSummary(falls_through=True, raises=False)


def _statement_can_fall_through(statement: ast.stmt) -> bool:
    return _statement_flow(statement).falls_through
