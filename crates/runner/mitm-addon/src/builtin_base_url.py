"""Builtin firewall base URL template resolution."""

import re
import urllib.parse

import matching
from authority_utils import percent_decode_host
from path_security import has_unsafe_path
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

_BASE_URL_VAR_PATTERN = re.compile(r"\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_URL_COMPONENT_DELIMITER_PATTERN = re.compile(r"[/?#]")
_AUTHORITY_VAR_STRUCTURE_CHARS = frozenset(("/", "?", "#", "@", "\\"))
_AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS = frozenset(("/", ":", "?", "#", "@", "\\"))
_PERCENT_DECODED_BOUNDARY_CHARS = frozenset(("/", ":", "?", "#", "@", "\\"))
_BASE_URL_VAR_PARAMETER_CHARS = frozenset(("{", "}"))
_PATH_VAR_STRUCTURE_CHARS = frozenset(("/", "?", "#", "\\"))
_PORT_VAR_PATTERN = re.compile(r"^[0-9]+$")
_MAX_PATH_VAR_PERCENT_DECODE_PASSES = 5


def _string_record(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise TypeError(f"{field_name} must be an object")

    result: dict[str, str] = {}
    for key, nested in value.items():
        if not isinstance(key, str) or not isinstance(nested, str):
            raise TypeError(f"{field_name} must contain string values")
        result[key] = nested
    return result


def base_url_vars_for_entry(entry: dict) -> dict[str, str]:
    if "baseUrlVars" in entry:
        return _string_record(entry["baseUrlVars"], "baseUrlVars")
    return {}


def _base_url_variable_error(
    *,
    firewall_name: str,
    base: str,
    name: str,
    detail: str,
) -> ValueError:
    return ValueError(
        f'builtin firewall "{firewall_name}" base URL variable "{name}" {detail}: {base}'
    )


def _validate_base_url_variable_common_syntax(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if has_raw_whitespace(value) or any(char.isspace() for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain whitespace",
        )
    if has_unsafe_url_codepoint(value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain control characters or invalid Unicode",
        )
    if any(char in _BASE_URL_VAR_PARAMETER_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain firewall parameter syntax",
        )


def _validate_base_url_variable_percent_encoding(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    structure_chars: frozenset[str] = _PERCENT_DECODED_BOUNDARY_CHARS,
) -> str:
    decoded = percent_decode_host(value, syntax_chars=structure_chars)
    if decoded.invalid_encoding:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="has invalid percent encoding",
        )
    if decoded.decoded_syntax or any(char.isspace() for char in decoded.value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain encoded URL structure",
        )
    if has_unsafe_url_codepoint(decoded.value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain encoded control characters or invalid Unicode",
        )
    return decoded.value


def _path_variable_value_has_encoded_structure(value: str) -> bool:
    current = value
    for _ in range(_MAX_PATH_VAR_PERCENT_DECODE_PASSES):
        decoded = percent_decode_host(current, syntax_chars=_PATH_VAR_STRUCTURE_CHARS)
        if (
            decoded.invalid_encoding
            or decoded.decoded_syntax
            or any(char.isspace() for char in decoded.value)
            or has_unsafe_url_codepoint(decoded.value)
        ):
            return True
        if decoded.value == current:
            return False
        current = decoded.value

    decoded = percent_decode_host(current, syntax_chars=_PATH_VAR_STRUCTURE_CHARS)
    return (
        decoded.invalid_encoding
        or decoded.decoded_syntax
        or decoded.value != current
        or any(char.isspace() for char in decoded.value)
        or has_unsafe_url_codepoint(decoded.value)
    )


def _validate_base_url_prefix_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if not matching.firewall_base_config_is_valid(value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a valid base URL before a fixed path suffix",
        )
    parts = urllib.parse.urlsplit(value)
    if parts.query or parts.fragment:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain query or fragment before a fixed path suffix",
        )
    if has_unsafe_path(parts.path):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain unsafe path segments before a fixed path suffix",
        )


def _validate_base_url_authority_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if any(char in _AUTHORITY_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce URL structure",
        )
    _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )
    if not matching.firewall_base_config_is_valid(f"https://{value}"):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a valid URL authority",
        )


def _validate_base_url_authority_fragment_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if any(char in _AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce URL structure",
        )
    _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )


def _validate_base_url_port_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if _PORT_VAR_PATTERN.fullmatch(value) is None:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a numeric URL port",
        )


def _validate_base_url_path_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    prefix: str,
    suffix: str,
) -> None:
    if any(char in _PATH_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce path structure",
        )
    decoded = _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
        structure_chars=_PATH_VAR_STRUCTURE_CHARS,
    )
    prefix_segment = prefix[prefix.rfind("/") + 1 :]
    suffix_delimiter = _URL_COMPONENT_DELIMITER_PATTERN.search(suffix)
    suffix_segment = suffix if suffix_delimiter is None else suffix[: suffix_delimiter.start()]
    if _path_variable_value_has_encoded_structure(decoded) or has_unsafe_path(
        f"/{prefix_segment}{decoded}{suffix_segment}"
    ):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain unsafe path segments",
        )


def _prefix_is_inside_authority(prefix: str) -> bool:
    scheme_end = prefix.find("://")
    if scheme_end == -1:
        return False
    after_scheme = prefix[scheme_end + 3 :]
    return _URL_COMPONENT_DELIMITER_PATTERN.search(after_scheme) is None


def _prefix_is_inside_path(prefix: str) -> bool:
    scheme_end = prefix.find("://")
    if scheme_end == -1:
        return False
    after_scheme = prefix[scheme_end + 3 :]
    if "?" in after_scheme or "#" in after_scheme:
        return False
    return "/" in after_scheme


def _suffix_authority_prefix(suffix: str) -> str:
    delimiter = _URL_COMPONENT_DELIMITER_PATTERN.search(suffix)
    if delimiter is None:
        return suffix
    return suffix[: delimiter.start()]


def _validate_base_url_template_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    prefix: str,
    suffix: str,
) -> None:
    _validate_base_url_variable_common_syntax(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )
    if prefix == "" and suffix == "":
        return
    if prefix == "" and suffix.startswith("/"):
        _validate_base_url_prefix_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if prefix.endswith("://") and (suffix == "" or suffix.startswith("/")):
        _validate_base_url_authority_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if (
        _prefix_is_inside_authority(prefix)
        and prefix.endswith(":")
        and (suffix == "" or suffix.startswith("/"))
    ):
        _validate_base_url_port_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if _prefix_is_inside_authority(prefix) and _suffix_authority_prefix(suffix) != "":
        _validate_base_url_authority_fragment_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if _prefix_is_inside_path(prefix):
        _validate_base_url_path_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
            prefix=prefix,
            suffix=suffix,
        )
        return
    raise _base_url_variable_error(
        firewall_name=firewall_name,
        base=base,
        name=name,
        detail="is used in an unsupported base URL template position",
    )


def resolve_base_url_template(
    *,
    firewall_name: str,
    base: str,
    vars_map: dict[str, str],
) -> str:
    resolved_parts: list[str] = []
    last_index = 0
    for match in _BASE_URL_VAR_PATTERN.finditer(base):
        name = match.group(1)
        value = vars_map.get(name)
        if not value:
            raise ValueError(
                f'builtin firewall "{firewall_name}" base URL requires variable "{name}"'
            )
        _validate_base_url_template_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
            prefix=base[: match.start()],
            suffix=base[match.end() :],
        )
        resolved_parts.append(base[last_index : match.start()])
        resolved_parts.append(value)
        last_index = match.end()

    resolved_parts.append(base[last_index:])
    resolved = "".join(resolved_parts)
    if not matching.firewall_base_config_is_valid(resolved):
        raise ValueError(f'builtin firewall "{firewall_name}" resolved base URL is invalid')
    if has_unsafe_path(urllib.parse.urlsplit(resolved).path):
        raise ValueError(
            f'builtin firewall "{firewall_name}" resolved base URL has unsafe path segments'
        )
    return resolved
