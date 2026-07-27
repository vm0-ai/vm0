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


def _static_first_call_argument_nodes(args: list[ast.expr]) -> list[ast.AST]:
    """Return static nodes that can occupy a call's first positional argument."""
    result: list[ast.AST] = []
    for argument in args:
        if isinstance(argument, ast.Starred):
            outcomes, has_unknown_expansion = _static_iterable_first_outcomes(argument.value)
            result.extend(outcome for outcome in outcomes if outcome is not None)
            if has_unknown_expansion or any(outcome is None for outcome in outcomes):
                continue
            break
        result.append(argument)
        break
    return result


def _deduplicate_static_argument_outcomes(
    outcomes: list[ast.AST | None],
) -> list[ast.AST | None]:
    result: list[ast.AST | None] = []
    seen_node_ids: set[int] = set()
    has_empty_outcome = False
    for outcome in outcomes:
        if outcome is None:
            if has_empty_outcome:
                continue
            has_empty_outcome = True
        else:
            node_id = id(outcome)
            if node_id in seen_node_ids:
                continue
            seen_node_ids.add(node_id)
        result.append(outcome)
    return result


def _static_iterable_first_outcomes(node: ast.AST) -> tuple[list[ast.AST | None], bool]:
    """Return ordered first-node/empty outcomes and whether any expansion is unknown.

    ``None`` represents a statically empty expansion. The unknown flag remains separate because
    the linter conservatively treats any dynamic nested expansion as a possible empty call prefix.
    """
    if isinstance(node, ast.NamedExpr):
        return _static_iterable_first_outcomes(node.value)
    if isinstance(node, ast.IfExp):
        body_outcomes, body_has_unknown_expansion = _static_iterable_first_outcomes(node.body)
        orelse_outcomes, orelse_has_unknown_expansion = _static_iterable_first_outcomes(node.orelse)
        return _deduplicate_static_argument_outcomes(
            [*body_outcomes, *orelse_outcomes]
        ), body_has_unknown_expansion or orelse_has_unknown_expansion
    if isinstance(node, ast.BoolOp):
        alternative_outcomes: list[ast.AST | None] = []
        has_unknown_expansion = False
        for value in node.values:
            value_outcomes, value_has_unknown_expansion = _static_iterable_first_outcomes(value)
            alternative_outcomes.extend(value_outcomes)
            has_unknown_expansion = has_unknown_expansion or value_has_unknown_expansion
        return (
            _deduplicate_static_argument_outcomes(alternative_outcomes),
            has_unknown_expansion,
        )
    if not isinstance(node, ast.List | ast.Tuple):
        return [], True
    outcomes: list[ast.AST | None] = [None]
    has_unknown_expansion = False
    for element in node.elts:
        if isinstance(element, ast.Starred):
            element_outcomes, element_has_unknown_expansion = _static_iterable_first_outcomes(
                element.value
            )
        else:
            element_outcomes = [element]
            element_has_unknown_expansion = False
        if any(outcome is None for outcome in outcomes):
            next_outcomes: list[ast.AST | None] = []
            for outcome in outcomes:
                if outcome is None:
                    next_outcomes.extend(element_outcomes)
                else:
                    next_outcomes.append(outcome)
            if element_has_unknown_expansion:
                next_outcomes.extend(outcomes)
            outcomes = _deduplicate_static_argument_outcomes(next_outcomes)
        has_unknown_expansion = has_unknown_expansion or element_has_unknown_expansion
    return outcomes, has_unknown_expansion


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


def _is_modeled_implicit_exception_operation(node: ast.AST) -> bool:
    """Return whether evaluating ``node`` performs a modeled fallible operation."""
    return isinstance(
        node,
        (
            ast.Attribute,
            ast.Await,
            ast.BinOp,
            ast.Call,
            ast.Compare,
            ast.Subscript,
            ast.UnaryOp,
            ast.YieldFrom,
        ),
    )


def _truth_test_may_raise(node: ast.AST) -> bool:
    """Return whether truth-testing an evaluated expression may invoke user code."""
    if isinstance(
        node,
        (
            ast.Constant,
            ast.Dict,
            ast.GeneratorExp,
            ast.JoinedStr,
            ast.Lambda,
            ast.List,
            ast.Set,
            ast.Tuple,
        ),
    ):
        return False
    if isinstance(node, ast.NamedExpr):
        return _truth_test_may_raise(node.value)
    if isinstance(node, ast.IfExp):
        return _truth_test_may_raise(node.body) or _truth_test_may_raise(node.orelse)
    if isinstance(node, ast.BoolOp):
        return any(_truth_test_may_raise(value) for value in node.values)
    return not (isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not))


def _static_truth_value(node: ast.AST) -> bool | None:
    """Return an expression's statically known truth value, if any."""
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
        if not node.elts:
            return False
        return True if any(not isinstance(element, ast.Starred) for element in node.elts) else None
    if isinstance(node, ast.Dict):
        if not node.keys:
            return False
        return True if any(key is not None for key in node.keys) else None
    if isinstance(node, (ast.GeneratorExp, ast.Lambda)):
        return True
    if isinstance(node, ast.NamedExpr):
        return _static_truth_value(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        operand_truth = _static_truth_value(node.operand)
        return None if operand_truth is None else not operand_truth
    return None


def _iteration_may_raise(node: ast.AST) -> bool:
    """Return whether obtaining or advancing this iterable may invoke user code."""
    if isinstance(
        node,
        (
            ast.Dict,
            ast.DictComp,
            ast.GeneratorExp,
            ast.JoinedStr,
            ast.List,
            ast.ListComp,
            ast.Set,
            ast.SetComp,
            ast.Tuple,
        ),
    ):
        return False
    return not (isinstance(node, ast.Constant) and isinstance(node.value, (bytes, str)))


def _iterable_is_statically_empty(node: ast.AST) -> bool:
    if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
        return not node.elts
    if isinstance(node, ast.Dict):
        return not node.keys
    return (
        isinstance(node, ast.Constant) and isinstance(node.value, (bytes, str)) and not node.value
    )


class _ModeledImplicitExceptionVisitor(ast.NodeVisitor):
    """Find modeled operations executed while evaluating one expression."""

    def __init__(self) -> None:
        self.may_raise = False

    def visit(self, node: ast.AST) -> None:
        if self.may_raise:
            return
        if _is_modeled_implicit_exception_operation(node):
            self.may_raise = True
            return
        super().visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        if not node.generators:
            return
        self.visit(node.generators[0].iter)
        if not self.may_raise and (
            node.generators[0].is_async or _iteration_may_raise(node.generators[0].iter)
        ):
            self.may_raise = True

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        for index, value in enumerate(node.values):
            self.visit(value)
            if self.may_raise or index == len(node.values) - 1:
                return
            if _truth_test_may_raise(value):
                self.may_raise = True
                return
            truth_value = _static_truth_value(value)
            if (isinstance(node.op, ast.And) and truth_value is False) or (
                isinstance(node.op, ast.Or) and truth_value is True
            ):
                return

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self.visit(node.test)
        if self.may_raise:
            return
        if _truth_test_may_raise(node.test):
            self.may_raise = True
            return
        test_truth = _static_truth_value(node.test)
        if test_truth is not False:
            self.visit(node.body)
        if not self.may_raise and test_truth is not True:
            self.visit(node.orelse)

    def _visit_eager_comprehension(
        self, generators: list[ast.comprehension], body: list[ast.AST]
    ) -> None:
        for generator in generators:
            self.visit(generator.iter)
            if self.may_raise:
                return
            if generator.is_async or _iteration_may_raise(generator.iter):
                self.may_raise = True
                return
            if _iterable_is_statically_empty(generator.iter):
                return
            for condition in generator.ifs:
                self.visit(condition)
                if self.may_raise:
                    return
                if _truth_test_may_raise(condition):
                    self.may_raise = True
                    return
        for expression in body:
            self.visit(expression)
            if self.may_raise:
                return

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_eager_comprehension(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_eager_comprehension(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_eager_comprehension(node.generators, [node.key, node.value])


def _expression_may_raise(node: ast.AST | None) -> bool:
    if node is None:
        return False
    visitor = _ModeledImplicitExceptionVisitor()
    visitor.visit(node)
    return visitor.may_raise


def _expressions_may_raise(nodes: list[ast.AST | None]) -> bool:
    return any(_expression_may_raise(node) for node in nodes)


def _assertion_may_raise(node: ast.Assert) -> bool:
    return (
        _expression_may_raise(node.test)
        or _truth_test_may_raise(node.test)
        or _static_truth_value(node.test) is not True
    )


def _function_definition_may_raise(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    return _expressions_may_raise(
        [
            *node.decorator_list,
            *_type_params(node),
            *node.args.defaults,
            *node.args.kw_defaults,
            *_argument_annotations(node.args),
            node.returns,
        ]
    )


def _class_definition_may_raise(node: ast.ClassDef) -> bool:
    return _expressions_may_raise(
        [
            *node.decorator_list,
            *_type_params(node),
            *node.bases,
            *node.keywords,
        ]
    )


def _with_protected_region_may_raise(items: list[ast.withitem], body_flow: _FlowSummary) -> bool:
    target_may_raise = any(
        _expression_may_raise(item.optional_vars)
        for item in items
        if item.optional_vars is not None
    )
    nested_context_may_raise = any(_expression_may_raise(item.context_expr) for item in items[1:])
    return target_may_raise or nested_context_may_raise or body_flow.raises


@dataclass(frozen=True)
class _FlowSummary:
    """Syntactic normal and modeled exceptional exits used by reachability."""

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
    raises = (
        raises
        or any(flow.raises for flow in handler_flows)
        or any(_expression_may_raise(handler.type) for handler in statement.handlers)
    )
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
    if isinstance(statement, ast.Assert):
        return _FlowSummary(
            falls_through=_static_truth_value(statement.test) is not False,
            raises=_assertion_may_raise(statement),
        )
    if isinstance(statement, ast.Return):
        return _FlowSummary(
            falls_through=False,
            raises=_expression_may_raise(statement.value),
        )
    if isinstance(statement, (ast.Break, ast.Continue)):
        return _FlowSummary(falls_through=False, raises=False)
    if isinstance(statement, ast.If):
        test_truth = _static_truth_value(statement.test)
        body_flow = _body_flow(statement.body)
        orelse_flow = (
            _body_flow(statement.orelse)
            if statement.orelse
            else _FlowSummary(falls_through=True, raises=False)
        )
        reachable_flows = []
        if test_truth is not False:
            reachable_flows.append(body_flow)
        if test_truth is not True:
            reachable_flows.append(orelse_flow)
        return _FlowSummary(
            falls_through=any(flow.falls_through for flow in reachable_flows),
            raises=(
                _expression_may_raise(statement.test)
                or _truth_test_may_raise(statement.test)
                or any(flow.raises for flow in reachable_flows)
            ),
        )
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        body_flow = _body_flow(statement.body)
        protected_region_may_raise = _with_protected_region_may_raise(statement.items, body_flow)
        return _FlowSummary(
            falls_through=body_flow.falls_through or protected_region_may_raise,
            raises=(
                _expression_may_raise(statement.items[0].context_expr) or protected_region_may_raise
            ),
        )
    if _is_try_statement(statement):
        return _try_statement_flow(statement)
    if isinstance(statement, (ast.For, ast.AsyncFor)):
        orelse_flow = _body_flow(statement.orelse)
        iterable_is_empty = isinstance(statement, ast.For) and _iterable_is_statically_empty(
            statement.iter
        )
        body_raises = False if iterable_is_empty else _body_flow(statement.body).raises
        return _FlowSummary(
            falls_through=orelse_flow.falls_through if iterable_is_empty else True,
            raises=(
                _expression_may_raise(statement.iter)
                or (
                    not iterable_is_empty
                    and (
                        isinstance(statement, ast.AsyncFor) or _iteration_may_raise(statement.iter)
                    )
                )
                or (not iterable_is_empty and _expression_may_raise(statement.target))
                or body_raises
                or orelse_flow.raises
            ),
        )
    if isinstance(statement, ast.While):
        test_truth = _static_truth_value(statement.test)
        orelse_flow = _body_flow(statement.orelse)
        body_raises = False if test_truth is False else _body_flow(statement.body).raises
        return _FlowSummary(
            falls_through=orelse_flow.falls_through if test_truth is False else True,
            raises=(
                _expression_may_raise(statement.test)
                or _truth_test_may_raise(statement.test)
                or body_raises
                or orelse_flow.raises
            ),
        )
    if isinstance(statement, ast.Match):
        case_falls_through = False
        has_unmatched_path = True
        raises = False
        for case in statement.cases:
            case_flow = _body_flow(case.body)
            case_falls_through = case_falls_through or case_flow.falls_through
            raises = (
                raises
                or _expression_may_raise(case.guard)
                or (case.guard is not None and _truth_test_may_raise(case.guard))
                or case_flow.raises
            )
            if case.guard is None and _pattern_is_exhaustive(case.pattern):
                has_unmatched_path = False
                break
        return _FlowSummary(
            falls_through=has_unmatched_path or case_falls_through,
            raises=_expression_may_raise(statement.subject) or raises,
        )
    if isinstance(statement, ast.ClassDef):
        body_flow = _body_flow(statement.body)
        return _FlowSummary(
            falls_through=body_flow.falls_through,
            raises=_class_definition_may_raise(statement) or body_flow.raises,
        )
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return _FlowSummary(
            falls_through=True,
            raises=_function_definition_may_raise(statement),
        )
    if isinstance(statement, ast.Expr):
        raises = _expression_may_raise(statement.value)
    elif isinstance(statement, ast.Assign):
        raises = _expressions_may_raise([statement.value, *statement.targets])
    elif isinstance(statement, ast.AnnAssign):
        raises = _expressions_may_raise([statement.value, statement.annotation, statement.target])
    elif isinstance(statement, ast.AugAssign):
        raises = True
    elif isinstance(statement, ast.Delete):
        raises = _expressions_may_raise(list(statement.targets))
    else:
        raises = False
    return _FlowSummary(falls_through=True, raises=raises)


def _statement_can_fall_through(statement: ast.stmt) -> bool:
    return _statement_flow(statement).falls_through
