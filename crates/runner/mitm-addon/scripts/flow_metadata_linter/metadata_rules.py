"""Metadata key-expression rules for flow metadata key linting."""

from __future__ import annotations

import ast
from pathlib import Path

from flow_metadata_linter.ast_helpers import _static_call_argument_nodes
from flow_metadata_linter.paths import ADDON_ROOT as _ADDON_ROOT
from flow_metadata_linter.registry import REGISTERED_METADATA_KEYS as _REGISTERED_METADATA_KEYS

_METADATA_PAIR_LENGTH = 2
_STRING_FORMAT_CONVERSION = ord("s")
_SEQUENCE_WRAPPER_CALLS = {"frozenset", "iter", "list", "reversed", "set", "sorted", "tuple"}


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
