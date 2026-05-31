"""Firewall URL/host/path pattern matching functions.

Pure functions with no module-level state or I/O.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Literal, NamedTuple
from urllib.parse import urlsplit

from path_security import has_unsafe_dot_segment

_SEGMENT_ERROR_HINT = 'use "{name}", "prefix{name}", "{name}suffix", or "prefix{name}suffix"'

# A segment with two or more ``{`` braces contains more than one parameter,
# which the grammar rejects — detected once here rather than scattering the
# literal ``2`` across the parser.
_MULTI_PARAM_BRACE_COUNT = 2

# Firewall rules are encoded as ``"METHOD path"`` — a single-whitespace-split
# yields exactly two tokens.  Rows that fail this shape are malformed.
_RULE_TOKEN_COUNT = 2


class _BaseUrlParts(NamedTuple):
    scheme: str
    authority: str
    path: str


class SegmentLiteral(NamedTuple):
    value: str


class SegmentParam(NamedTuple):
    prefix: str
    name: str
    suffix: str
    greedy: str


class SegmentError(NamedTuple):
    reason: str


ParsedSegment = SegmentLiteral | SegmentParam | SegmentError
_PathSpecificity = tuple[int, int, int, int, int, int, int]


class CompiledPathPattern(NamedTuple):
    segments: tuple[ParsedSegment, ...]


class _CompiledBase(NamedTuple):
    raw: str
    parts: _BaseUrlParts
    has_params: bool
    host_segments: tuple[ParsedSegment, ...]
    path_segments: tuple[ParsedSegment, ...]


class _CompiledRule(NamedTuple):
    method: str
    raw: str
    path: CompiledPathPattern
    specificity: _PathSpecificity


class _CompiledPermission(NamedTuple):
    name: str
    rules: tuple[_CompiledRule, ...]


class _CompiledApi(NamedTuple):
    raw_api_entry: dict
    base: _CompiledBase
    permissions: tuple[_CompiledPermission, ...]
    # True when API compilation encountered malformed permissions/rules config.
    has_malformed_rules: bool


class _CompiledFirewall(NamedTuple):
    name: str
    apis: tuple[_CompiledApi, ...]


class CompiledFirewallSet(NamedTuple):
    firewalls: tuple[_CompiledFirewall, ...]


UnknownPolicy = Literal["allow", "deny", "ask"]


class _CompiledNetworkPolicy(NamedTuple):
    blocked_permissions: frozenset[str]
    unknown_policy: UnknownPolicy
    permission_malformed: bool
    unknown_policy_malformed: bool


class CompiledNetworkPolicies(NamedTuple):
    policies: Mapping[str, _CompiledNetworkPolicy]
    top_level_malformed: bool


class _CompiledRuleCandidate(NamedTuple):
    permission: str
    rule: str
    params: dict[str, str]


def _split_base_match_url(
    value: str,
    *,
    allow_query_fragment: bool = True,
) -> _BaseUrlParts | None:
    """Split a URL-like string for firewall base matching.

    Keeps the raw authority, including any explicit port. The returned path
    excludes query and fragment so callers can apply base-path prefix semantics
    without accidentally comparing query strings.
    """
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    if not allow_query_fragment and (parts.query or parts.fragment):
        return None

    return _BaseUrlParts(
        scheme=parts.scheme,
        authority=parts.netloc,
        path=parts.path,
    )


def _parse_segment(seg: str) -> ParsedSegment:
    """Parse a single host or path segment into an immutable result."""
    open_count = seg.count("{")
    close_count = seg.count("}")

    if open_count == 0 and close_count == 0:
        return SegmentLiteral(seg)
    if open_count != close_count:
        return SegmentError(f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    open1 = seg.find("{")
    close1 = seg.find("}")
    if close1 < open1:
        return SegmentError(f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    if open_count >= _MULTI_PARAM_BRACE_COUNT:
        open2 = seg.find("{", close1 + 1)
        if close1 + 1 == open2:
            return SegmentError(
                f'adjacent parameters in segment "{seg}" — only one parameter '
                f"per segment is allowed; {_SEGMENT_ERROR_HINT}"
            )
        return SegmentError(
            f'literal-separated parameters in segment "{seg}" — only one parameter '
            f"per segment is allowed; {_SEGMENT_ERROR_HINT}"
        )

    prefix = seg[:open1]
    content = seg[open1 + 1 : close1]
    suffix = seg[close1 + 1 :]

    if "{" in prefix or "}" in prefix or "{" in suffix or "}" in suffix:
        return SegmentError(f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    greedy = ""
    name = content
    if len(content) > 0 and content[-1] in ("+", "*"):
        greedy = content[-1]
        name = content[:-1]

    if len(name) == 0:
        return SegmentError(f'empty parameter name in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    return SegmentParam(prefix, name, suffix, greedy)


def parse_segment(seg: str) -> dict:
    """Parse a single host or path segment into literal / param / error.

    Grammar mirrors turbo/packages/connectors/src/segment-parser.ts —
    keep both implementations in lockstep. Any change to accepted or
    rejected forms must land in both languages at once.

    Returns one of:
      {"kind": "literal", "value": seg}
      {"kind": "param", "prefix": str, "name": str, "suffix": str,
       "greedy": "" | "+" | "*"}
      {"kind": "error", "reason": str}
    """
    parsed = _parse_segment(seg)
    if isinstance(parsed, SegmentLiteral):
        return {"kind": "literal", "value": parsed.value}
    if isinstance(parsed, SegmentParam):
        return {
            "kind": "param",
            "prefix": parsed.prefix,
            "name": parsed.name,
            "suffix": parsed.suffix,
            "greedy": parsed.greedy,
        }
    return {"kind": "error", "reason": parsed.reason}


def _match_segment_literal(runtime: str, prefix: str, suffix: str) -> str | None:
    """Match runtime segment against a mixed pattern's literal prefix/suffix.

    Byte-exact comparison; the caller is responsible for case-folding
    `runtime`, `prefix`, and `suffix` when needed (e.g., host matching).
    Returns the captured middle on success, None if either the prefix/suffix
    don't match or the middle would be empty.
    """
    if not runtime.startswith(prefix):
        return None
    if not runtime.endswith(suffix):
        return None
    if len(runtime) <= len(prefix) + len(suffix):
        return None
    return runtime[len(prefix) : len(runtime) - len(suffix)]


def match_host(host: str, pattern: str) -> dict | None:
    """Match a hostname against a pattern. Returns extracted params or None.

    Segments are `.`-delimited. Since subdomains grow leftward, greedy params
    ({name+}, {name*}) must appear in the first (leftmost) position.

    - Literal segments must match exactly (case-insensitive).
    - {name} matches a single host segment.
    - prefix{name}suffix matches a host segment case-insensitively, with
      the non-empty middle captured into `name` (case preserved from host).
    - {name+} matches one or more leading host segments. Must be first.
    - {name*} matches zero or more leading host segments. Must be first.
    """
    # Preserve original host case for param value capture; compare via
    # lowered copies.
    host_segs_orig = host.split(".")
    host_segs_lower = [s.lower() for s in host_segs_orig]
    pattern_segs_orig = pattern.split(".")

    params: dict[str, str] = {}

    # Match right-to-left: reverse both, then match like a path.
    host_segs_orig = list(reversed(host_segs_orig))
    host_segs_lower = list(reversed(host_segs_lower))
    pattern_segs_orig = list(reversed(pattern_segs_orig))

    hi = 0
    for seg_orig in pattern_segs_orig:
        parsed = parse_segment(seg_orig)
        # Invalid patterns are rejected at config load time; a runtime
        # error here means the config is already broken, so bail.
        if parsed["kind"] == "error":
            return None
        if parsed["kind"] == "literal":
            if hi >= len(host_segs_lower) or host_segs_lower[hi] != parsed["value"].lower():
                return None
            hi += 1
            continue
        name = parsed["name"]
        greedy = parsed["greedy"]
        prefix = parsed["prefix"]
        suffix = parsed["suffix"]
        if greedy == "+":
            if hi >= len(host_segs_orig):
                return None
            remaining = list(reversed(host_segs_orig[hi:]))
            params[name] = ".".join(remaining)
            return params
        if greedy == "*":
            remaining = list(reversed(host_segs_orig[hi:]))
            params[name] = ".".join(remaining)
            return params
        if hi >= len(host_segs_orig):
            return None
        if prefix == "" and suffix == "":
            # Preserve legacy behavior: host param captures are lowercased.
            params[name] = host_segs_lower[hi]
        else:
            # Mixed segment: match against lowered runtime + lowered
            # prefix/suffix to maintain the case-insensitive host contract.
            captured = _match_segment_literal(host_segs_lower[hi], prefix.lower(), suffix.lower())
            if captured is None:
                return None
            params[name] = captured
        hi += 1

    if hi != len(host_segs_orig):
        return None
    return params


def match_path_prefix(path_segs: list[str], pattern_segs: list[str]) -> tuple[dict, int] | None:
    """Match pattern segments against the beginning of path segments.

    Unlike match_path(), does NOT require full path consumption.
    Does NOT support greedy params (not allowed in base URL paths).
    Mixed segments (prefix{name}suffix) are supported with non-empty
    middle capture.

    Returns (params, consumed_count) on match, None on no match.
    """
    params: dict[str, str] = {}
    pi = 0

    for seg in pattern_segs:
        parsed = parse_segment(seg)
        if parsed["kind"] == "error":
            return None
        if parsed["kind"] == "literal":
            if pi >= len(path_segs) or path_segs[pi] != parsed["value"]:
                return None
            pi += 1
            continue
        if pi >= len(path_segs):
            return None
        name = parsed["name"]
        prefix = parsed["prefix"]
        suffix = parsed["suffix"]
        runtime = path_segs[pi]
        if prefix == "" and suffix == "":
            params[name] = runtime
        else:
            captured = _match_segment_literal(runtime, prefix, suffix)
            if captured is None:
                return None
            params[name] = captured
        pi += 1

    return params, pi


def match_base_url(url: str, base: str) -> tuple[str, dict] | None:
    """Match a request URL against a (possibly parameterized) base URL.

    Returns (rel_path, params) on match, None on no match.
    - rel_path: the path after the base (for permission rule matching)
    - params: extracted parameters from the base URL
    """
    url_parts = _split_base_match_url(url)
    if url_parts is None:
        return None

    # Fast path: no parameters - compare scheme/authority independently so
    # host casing cannot bypass static firewall bases, while paths remain
    # case-sensitive.
    if "{" not in base:
        base_parts = _split_base_match_url(base.rstrip("/"), allow_query_fragment=False)
        if base_parts is None:
            return None
        if url_parts.scheme.lower() != base_parts.scheme.lower():
            return None
        if url_parts.authority.lower() != base_parts.authority.lower():
            return None

        base_path = base_parts.path
        if base_path and not url_parts.path.startswith(base_path):
            return None
        rest = url_parts.path[len(base_path) :] if base_path else url_parts.path
        if rest and rest[0] != "/":
            return None
        rel_path = rest or "/"
        return rel_path, {}

    # Parameterized base URL: parse into scheme, host pattern, path pattern
    base_parts = _split_base_match_url(base, allow_query_fragment=False)
    if base_parts is None:
        return None

    # Request must start with same scheme
    if url_parts.scheme.lower() != base_parts.scheme.lower():
        return None

    # Match host directly — do NOT strip port. Non-standard ports (e.g., :8443)
    # are included in URLs by get_original_url() and must NOT match base patterns
    # without an explicit port, otherwise auth headers could leak to rogue servers.
    # Standard ports (443 for https, 80 for http) are omitted from URLs by
    # get_original_url(), so they match naturally.
    host_params = match_host(url_parts.authority, base_parts.authority)
    if host_params is None:
        return None

    # Match base path prefix
    base_path = base_parts.path
    clean_url_path = url_parts.path
    if base_path and base_path != "/":
        base_path_segs = [s for s in base_path.split("/") if s]
        url_path_segs = [s for s in clean_url_path.split("/") if s]
        path_result = match_path_prefix(url_path_segs, base_path_segs)
        if path_result is None:
            return None
        path_params, consumed = path_result
        remaining_segs = url_path_segs[consumed:]
        rel_path = "/" + "/".join(remaining_segs) if remaining_segs else "/"
        all_params = {**host_params, **path_params}
    else:
        rel_path = clean_url_path or "/"
        all_params = host_params

    return rel_path, all_params


def match_path(path: str, pattern: str) -> dict | None:
    """Match a URL path against a rule pattern. Returns extracted params or None.

    - Literal segments must match exactly.
    - {name} matches a single non-empty path segment.
    - prefix{name}suffix matches a segment that starts with `prefix` and
      ends with `suffix`, capturing the non-empty middle into `name`.
    - {name+} matches the rest of the path (one or more segments). Must be last.
    - {name*} matches the rest of the path (zero or more segments). Must be last.
    """
    path_segs = [s for s in path.split("/") if s]
    pattern_segs = [s for s in pattern.split("/") if s]

    params: dict[str, str] = {}
    pi = 0

    # Note: greedy params ({name+}, {name*}) must be the last segment.
    # This invariant is enforced at compose time by validateRule() in firewall-expander.ts.
    for seg in pattern_segs:
        parsed = parse_segment(seg)
        if parsed["kind"] == "error":
            return None
        if parsed["kind"] == "literal":
            if pi >= len(path_segs) or path_segs[pi] != parsed["value"]:
                return None
            pi += 1
            continue
        name = parsed["name"]
        greedy = parsed["greedy"]
        prefix = parsed["prefix"]
        suffix = parsed["suffix"]
        if greedy == "+":
            if pi >= len(path_segs):
                return None
            params[name] = "/".join(path_segs[pi:])
            return params
        if greedy == "*":
            params[name] = "/".join(path_segs[pi:])
            return params
        if pi >= len(path_segs):
            return None
        runtime = path_segs[pi]
        if prefix == "" and suffix == "":
            params[name] = runtime
        else:
            captured = _match_segment_literal(runtime, prefix, suffix)
            if captured is None:
                return None
            params[name] = captured
        pi += 1

    # All pattern segments consumed; path must also be fully consumed
    if pi != len(path_segs):
        return None
    return params


def _compile_segments(segments: list[str] | tuple[str, ...]) -> tuple[ParsedSegment, ...] | None:
    parsed = tuple(_parse_segment(seg) for seg in segments)
    if any(isinstance(seg, SegmentError) for seg in parsed):
        return None
    return parsed


def compile_path_pattern(pattern: str) -> CompiledPathPattern | None:
    """Compile a URL path pattern for repeated matching."""
    segments = _compile_segments(tuple(s for s in pattern.split("/") if s))
    if segments is None:
        return None
    return CompiledPathPattern(segments)


def _path_specificity(
    pattern: CompiledPathPattern,
) -> _PathSpecificity:
    literal_segments = 0
    mixed_param_segments = 0
    plain_param_segments = 0
    plus_greedy_segments = 0
    star_greedy_segments = 0
    literal_chars = 0

    for segment in pattern.segments:
        if isinstance(segment, SegmentLiteral):
            literal_segments += 1
            literal_chars += len(segment.value)
            continue
        if isinstance(segment, SegmentError):
            continue

        literal_chars += len(segment.prefix) + len(segment.suffix)
        if segment.prefix or segment.suffix:
            mixed_param_segments += 1
        elif segment.greedy == "+":
            plus_greedy_segments += 1
        elif segment.greedy == "*":
            star_greedy_segments += 1
        else:
            plain_param_segments += 1

    return (
        literal_segments,
        mixed_param_segments,
        plain_param_segments,
        plus_greedy_segments,
        -star_greedy_segments,
        literal_chars,
        len(pattern.segments),
    )


def _match_compiled_path_segments(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
) -> dict | None:
    params: dict[str, str] = {}
    pi = 0

    for parsed in pattern_segs:
        if isinstance(parsed, SegmentLiteral):
            if pi >= len(path_segs) or path_segs[pi] != parsed.value:
                return None
            pi += 1
            continue

        if isinstance(parsed, SegmentError):
            return None

        if parsed.greedy == "+":
            if pi >= len(path_segs):
                return None
            params[parsed.name] = "/".join(path_segs[pi:])
            return params
        if parsed.greedy == "*":
            params[parsed.name] = "/".join(path_segs[pi:])
            return params
        if pi >= len(path_segs):
            return None

        runtime = path_segs[pi]
        if parsed.prefix == "" and parsed.suffix == "":
            params[parsed.name] = runtime
        else:
            captured = _match_segment_literal(runtime, parsed.prefix, parsed.suffix)
            if captured is None:
                return None
            params[parsed.name] = captured
        pi += 1

    if pi != len(path_segs):
        return None
    return params


def match_compiled_path(path: str, pattern: CompiledPathPattern) -> dict | None:
    """Match a URL path against a compiled rule path pattern."""
    return _match_compiled_path_segments([s for s in path.split("/") if s], pattern.segments)


def _match_compiled_path_prefix(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
) -> tuple[dict, int] | None:
    params: dict[str, str] = {}
    pi = 0

    for parsed in pattern_segs:
        if isinstance(parsed, SegmentLiteral):
            if pi >= len(path_segs) or path_segs[pi] != parsed.value:
                return None
            pi += 1
            continue

        if isinstance(parsed, SegmentError):
            return None
        if pi >= len(path_segs):
            return None

        runtime = path_segs[pi]
        if parsed.prefix == "" and parsed.suffix == "":
            params[parsed.name] = runtime
        else:
            captured = _match_segment_literal(runtime, parsed.prefix, parsed.suffix)
            if captured is None:
                return None
            params[parsed.name] = captured
        pi += 1

    return params, pi


def _match_compiled_host(
    host: str,
    pattern_segs_reversed: tuple[ParsedSegment, ...],
) -> dict | None:
    host_segs_orig = host.split(".")
    host_segs_lower = [s.lower() for s in host_segs_orig]
    host_segs_orig = list(reversed(host_segs_orig))
    host_segs_lower = list(reversed(host_segs_lower))

    params: dict[str, str] = {}
    hi = 0
    for parsed in pattern_segs_reversed:
        if isinstance(parsed, SegmentLiteral):
            if hi >= len(host_segs_lower) or host_segs_lower[hi] != parsed.value.lower():
                return None
            hi += 1
            continue

        if isinstance(parsed, SegmentError):
            return None

        if parsed.greedy == "+":
            if hi >= len(host_segs_orig):
                return None
            remaining = list(reversed(host_segs_orig[hi:]))
            params[parsed.name] = ".".join(remaining)
            return params
        if parsed.greedy == "*":
            remaining = list(reversed(host_segs_orig[hi:]))
            params[parsed.name] = ".".join(remaining)
            return params
        if hi >= len(host_segs_orig):
            return None
        if parsed.prefix == "" and parsed.suffix == "":
            params[parsed.name] = host_segs_lower[hi]
        else:
            captured = _match_segment_literal(
                host_segs_lower[hi],
                parsed.prefix.lower(),
                parsed.suffix.lower(),
            )
            if captured is None:
                return None
            params[parsed.name] = captured
        hi += 1

    if hi != len(host_segs_orig):
        return None
    return params


def _compile_base(raw_base: str) -> _CompiledBase | None:
    base = raw_base.rstrip("/")
    if not base:
        return None

    has_params = "{" in base
    parts = _split_base_match_url(base, allow_query_fragment=False)
    if parts is None:
        return None

    host_segments: tuple[ParsedSegment, ...] = ()
    path_segments: tuple[ParsedSegment, ...] = ()
    if has_params:
        compiled_host = _compile_segments(tuple(reversed(parts.authority.split("."))))
        if compiled_host is None:
            return None
        host_segments = compiled_host
        compiled_path = _compile_segments(tuple(s for s in parts.path.split("/") if s))
        if compiled_path is None:
            return None
        path_segments = compiled_path

    return _CompiledBase(base, parts, has_params, host_segments, path_segments)


def _match_compiled_base_url_parts(
    url_parts: _BaseUrlParts,
    base: _CompiledBase,
) -> tuple[str, dict] | None:
    if not base.has_params:
        if url_parts.scheme.lower() != base.parts.scheme.lower():
            return None
        if url_parts.authority.lower() != base.parts.authority.lower():
            return None

        base_path = base.parts.path
        if base_path and not url_parts.path.startswith(base_path):
            return None
        rest = url_parts.path[len(base_path) :] if base_path else url_parts.path
        if rest and rest[0] != "/":
            return None
        rel_path = rest or "/"
        return rel_path, {}

    if url_parts.scheme.lower() != base.parts.scheme.lower():
        return None

    host_params = _match_compiled_host(url_parts.authority, base.host_segments)
    if host_params is None:
        return None

    base_path = base.parts.path
    clean_url_path = url_parts.path
    if base_path and base_path != "/":
        url_path_segs = [s for s in clean_url_path.split("/") if s]
        path_result = _match_compiled_path_prefix(url_path_segs, base.path_segments)
        if path_result is None:
            return None
        path_params, consumed = path_result
        remaining_segs = url_path_segs[consumed:]
        rel_path = "/" + "/".join(remaining_segs) if remaining_segs else "/"
        all_params = {**host_params, **path_params}
    else:
        rel_path = clean_url_path or "/"
        all_params = host_params

    return rel_path, all_params


def _compile_rule(rule_str: str) -> _CompiledRule | None:
    parts = rule_str.split(" ", 1)
    if len(parts) != _RULE_TOKEN_COUNT:
        return None
    pattern = compile_path_pattern(parts[1])
    if pattern is None:
        return None
    return _CompiledRule(parts[0].upper(), rule_str, pattern, _path_specificity(pattern))


def compile_firewalls(vm_firewalls: list | None) -> CompiledFirewallSet | None:
    """Compile raw firewall config into immutable matcher-side data."""
    if not vm_firewalls:
        return None

    compiled_firewalls: list[_CompiledFirewall] = []
    for fw_entry in vm_firewalls:
        if not isinstance(fw_entry, dict):
            continue

        raw_apis = fw_entry.get("apis", [])
        if not isinstance(raw_apis, list):
            continue

        compiled_apis: list[_CompiledApi] = []
        for api_entry in raw_apis:
            if not isinstance(api_entry, dict):
                continue
            raw_base = api_entry.get("base", "")
            if not isinstance(raw_base, str):
                continue
            base = _compile_base(raw_base)
            if base is None:
                continue

            compiled_permissions: list[_CompiledPermission] = []
            has_malformed_rules = False
            permissions = api_entry.get("permissions")
            if isinstance(permissions, list):
                for perm in permissions:
                    if not isinstance(perm, dict):
                        has_malformed_rules = True
                        continue
                    raw_rules = perm.get("rules", [])
                    if not isinstance(raw_rules, list):
                        raw_rules = []
                        has_malformed_rules = True

                    compiled_rules: list[_CompiledRule] = []
                    for rule_str in raw_rules:
                        if not isinstance(rule_str, str):
                            has_malformed_rules = True
                            continue
                        rule = _compile_rule(rule_str)
                        if rule is None:
                            has_malformed_rules = True
                            continue
                        compiled_rules.append(rule)

                    compiled_permissions.append(
                        _CompiledPermission(perm.get("name", ""), tuple(compiled_rules))
                    )
            elif permissions is not None:
                has_malformed_rules = True

            compiled_apis.append(
                _CompiledApi(api_entry, base, tuple(compiled_permissions), has_malformed_rules)
            )

        if compiled_apis:
            compiled_firewalls.append(
                _CompiledFirewall(fw_entry.get("name", ""), tuple(compiled_apis))
            )

    if not compiled_firewalls:
        return None
    return CompiledFirewallSet(tuple(compiled_firewalls))


def _compile_permission_set(raw_value: object | None) -> tuple[frozenset[str], bool]:
    if raw_value is None:
        return frozenset(), False
    if not isinstance(raw_value, list):
        return frozenset(), True
    if not all(isinstance(item, str) for item in raw_value):
        return frozenset(), True
    return frozenset(raw_value), False


def compile_network_policies(raw_network_policies: object | None) -> CompiledNetworkPolicies:
    """Compile raw networkPolicies into immutable matcher-side data."""
    if raw_network_policies is None:
        return CompiledNetworkPolicies(MappingProxyType({}), False)
    if not isinstance(raw_network_policies, dict):
        return CompiledNetworkPolicies(MappingProxyType({}), True)

    compiled: dict[str, _CompiledNetworkPolicy] = {}
    for fw_name, grant in raw_network_policies.items():
        if not isinstance(fw_name, str):
            continue

        if not isinstance(grant, dict):
            compiled[fw_name] = _CompiledNetworkPolicy(
                frozenset(),
                "allow",
                True,
                False,
            )
            continue

        deny, deny_malformed = _compile_permission_set(grant.get("deny"))
        ask, ask_malformed = _compile_permission_set(grant.get("ask"))

        raw_unknown_policy = grant.get("unknownPolicy")
        unknown_policy: UnknownPolicy = "allow"
        unknown_policy_malformed = False
        if raw_unknown_policy is None:
            unknown_policy = "allow"
        elif raw_unknown_policy in ("allow", "deny", "ask"):
            unknown_policy = raw_unknown_policy
        else:
            unknown_policy_malformed = True

        compiled[fw_name] = _CompiledNetworkPolicy(
            deny | ask,
            unknown_policy,
            deny_malformed or ask_malformed,
            unknown_policy_malformed,
        )

    return CompiledNetworkPolicies(MappingProxyType(compiled), False)


def _ensure_compiled_network_policies(
    network_policies: object | None,
) -> CompiledNetworkPolicies:
    if isinstance(network_policies, CompiledNetworkPolicies):
        return network_policies
    return compile_network_policies(network_policies)


class FirewallAllow(NamedTuple):
    """Base URL matched and auth headers should be injected.

    ``permission`` and ``rule`` are present for a matched permission. They are
    ``None`` for unknown-endpoint allow, where the firewall base matched but no
    permission rule did and ``unknownPolicy`` allowed the request.
    """

    api_entry: dict
    name: str
    permission: str | None
    params: dict[str, str]
    rule: str | None
    rel_path: str


def _permission_allow(
    api_entry: dict,
    *,
    name: str,
    permission: str,
    params: dict[str, str],
    rule: str,
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, permission, params, rule, rel_path)


def _unknown_allow(
    api_entry: dict,
    *,
    name: str,
    params: dict[str, str],
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, None, params, None, rel_path)


def _best_compiled_rule_candidates(
    api_entry: _CompiledApi,
    *,
    upper_method: str,
    rel_path: str,
    base_params: dict[str, str],
) -> list[_CompiledRuleCandidate]:
    rel_path_segs = [s for s in rel_path.split("/") if s]
    best_specificity: _PathSpecificity | None = None
    best_candidates: list[_CompiledRuleCandidate] = []

    for perm in api_entry.permissions:
        for rule in perm.rules:
            if rule.method not in ("ANY", upper_method):
                continue

            params = _match_compiled_path_segments(rel_path_segs, rule.path.segments)
            if params is None:
                continue

            if best_specificity is None or rule.specificity > best_specificity:
                best_specificity = rule.specificity
                best_candidates = []
            if rule.specificity == best_specificity:
                best_candidates.append(
                    _CompiledRuleCandidate(
                        perm.name,
                        rule.raw,
                        {**base_params, **params},
                    )
                )

    return best_candidates


FirewallBlockReason = Literal[
    "permission_denied",
    "unknown_endpoint",
    "malformed_firewall_config",
    "malformed_network_policy",
    "unsafe_path",
]


class FirewallBlock(NamedTuple):
    """Base URL matched but the request should return 403."""

    base: str
    name: str
    method: str
    path: str
    permissions: tuple[str, ...]  # denied/asked permission names only
    reason: FirewallBlockReason


def match_compiled_firewall_request(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None = None,
) -> FirewallAllow | FirewallBlock | None:
    """Match request against production precompiled firewall permissions.

    Returns:
      FirewallAllow — granted permission matched or unknown endpoint allowed
      FirewallBlock — permission denied, unknown endpoint blocked, or matched
        malformed firewall/network policy config or unsafe path failed closed
      None — no base URL match (not a firewall request)

    ``unknownPolicy="ask"`` is treated as block at the proxy layer.
    """
    if not compiled_firewalls:
        return None

    url_parts = _split_base_match_url(url)
    if url_parts is None:
        return None

    compiled_network_policies = _ensure_compiled_network_policies(network_policies)

    blocked_match: tuple[str, str, str, dict, dict] | None = None

    upper_method = method.upper()

    denied_match: tuple[str, str, str, str] | None = None
    denied_perm_names: list[str] = []
    malformed_match: tuple[str, str, str, str] | None = None
    malformed_policy_match: tuple[str, str, str, str] | None = None

    for fw_entry in compiled_firewalls.firewalls:
        policy = compiled_network_policies.policies.get(fw_entry.name)

        for api_entry in fw_entry.apis:
            base_result = _match_compiled_base_url_parts(url_parts, api_entry.base)
            if base_result is None:
                continue

            rel_path, base_params = base_result

            if has_unsafe_dot_segment(url_parts.path):
                return FirewallBlock(
                    api_entry.base.raw,
                    fw_entry.name,
                    upper_method,
                    rel_path,
                    (),
                    "unsafe_path",
                )

            if blocked_match is None:
                blocked_match = (
                    api_entry.base.raw,
                    fw_entry.name,
                    rel_path,
                    api_entry.raw_api_entry,
                    base_params,
                )
            if api_entry.has_malformed_rules and malformed_match is None:
                malformed_match = (api_entry.base.raw, fw_entry.name, upper_method, rel_path)
            if compiled_network_policies.top_level_malformed or (
                policy is not None and policy.permission_malformed
            ):
                if malformed_policy_match is None:
                    malformed_policy_match = (
                        api_entry.base.raw,
                        fw_entry.name,
                        upper_method,
                        rel_path,
                    )
                continue

            if not api_entry.permissions:
                continue

            candidates = _best_compiled_rule_candidates(
                api_entry,
                upper_method=upper_method,
                rel_path=rel_path,
                base_params=base_params,
            )
            if not candidates:
                continue

            api_denied_perm_names: list[str] = []
            for candidate in candidates:
                if policy is None or candidate.permission not in policy.blocked_permissions:
                    return _permission_allow(
                        api_entry.raw_api_entry,
                        name=fw_entry.name,
                        permission=candidate.permission,
                        params=candidate.params,
                        rule=candidate.rule,
                        rel_path=rel_path,
                    )
                if candidate.permission not in api_denied_perm_names:
                    api_denied_perm_names.append(candidate.permission)

            for perm_name in api_denied_perm_names:
                if perm_name not in denied_perm_names:
                    denied_perm_names.append(perm_name)
            if api_denied_perm_names and denied_match is None:
                denied_match = (
                    api_entry.base.raw,
                    fw_entry.name,
                    upper_method,
                    rel_path,
                )

    if blocked_match is not None:
        blocked_base, blocked_name, blocked_rel_path, first_matched_api_entry, base_params = (
            blocked_match
        )
        if denied_match is not None:
            return FirewallBlock(
                *denied_match,
                tuple(denied_perm_names),
                "permission_denied",
            )
        if malformed_policy_match is not None:
            return FirewallBlock(*malformed_policy_match, (), "malformed_network_policy")
        if malformed_match is not None:
            return FirewallBlock(*malformed_match, (), "malformed_firewall_config")

        blocked_policy = compiled_network_policies.policies.get(blocked_name)
        if blocked_policy is None:
            return _unknown_allow(
                first_matched_api_entry,
                name=blocked_name,
                params=base_params,
                rel_path=blocked_rel_path,
            )
        if blocked_policy.unknown_policy_malformed:
            return FirewallBlock(
                blocked_base,
                blocked_name,
                upper_method,
                blocked_rel_path,
                (),
                "malformed_network_policy",
            )
        if blocked_policy.unknown_policy == "allow":
            return _unknown_allow(
                first_matched_api_entry,
                name=blocked_name,
                params=base_params,
                rel_path=blocked_rel_path,
            )
        return FirewallBlock(
            blocked_base,
            blocked_name,
            upper_method,
            blocked_rel_path,
            (),
            "unknown_endpoint",
        )
    return None


def match_firewall_request(
    url: str,
    method: str,
    vm_firewalls: list | None,
    network_policies: object | None = None,
) -> FirewallAllow | FirewallBlock | None:
    """Match request against firewall permissions with three-level matching.

    The compiled matcher is the production-authoritative path. This legacy
    matcher is kept for direct raw-config comparisons. It shares compiled
    network policy handling but does not fail closed on malformed firewall
    rules.

    Returns:
      FirewallAllow — granted permission matched or unknown endpoint allowed
      FirewallBlock — base URL matched but permission denied, unknown blocked,
        unsafe path blocked, or malformed network policy failed closed
      None — no base URL match (not a firewall request)
    """
    if not vm_firewalls:
        return None

    url_parts = _split_base_match_url(url)
    if url_parts is None:
        return None

    compiled_network_policies = _ensure_compiled_network_policies(network_policies)

    # Track the first matched base URL and api_entry for unknown endpoint auth.
    blocked_match: tuple[str, str, str, dict, dict] | None = None

    upper_method = method.upper()

    # Track the first non-granted permission match — used for DENY when no
    # granted permission matches.  We record it instead of returning immediately
    # because a later permission may be granted for the same endpoint.
    denied_match: tuple[str, str, str, str] | None = None  # (base, name, method, path)
    denied_perm_names: list[str] = []
    malformed_policy_match: tuple[str, str, str, str] | None = None

    for fw_entry in vm_firewalls:
        fw_name = fw_entry.get("name", "")
        policy = compiled_network_policies.policies.get(fw_name)

        for api_entry in fw_entry.get("apis", []):
            base = api_entry.get("base", "").rstrip("/")
            if not base:
                continue

            base_result = match_base_url(url, base)
            if base_result is None:
                continue

            rel_path, base_params = base_result

            if has_unsafe_dot_segment(url_parts.path):
                return FirewallBlock(
                    base,
                    fw_name,
                    upper_method,
                    rel_path,
                    (),
                    "unsafe_path",
                )

            # Base URL matched
            if blocked_match is None:
                blocked_match = (base, fw_name, rel_path, api_entry, base_params)

            if compiled_network_policies.top_level_malformed or (
                policy is not None and policy.permission_malformed
            ):
                if malformed_policy_match is None:
                    malformed_policy_match = (base, fw_name, upper_method, rel_path)
                continue

            permissions = api_entry.get("permissions")
            if not permissions:
                # No permissions defined — handled by unknown logic below
                continue

            for perm in permissions:
                perm_name = perm.get("name", "")
                for rule_str in perm.get("rules", []):
                    parts = rule_str.split(" ", 1)
                    if len(parts) != _RULE_TOKEN_COUNT:
                        continue
                    rule_method = parts[0].upper()
                    rest = parts[1]
                    if rule_method not in ("ANY", upper_method):
                        continue

                    params = match_path(rel_path, rest)
                    if params is not None:
                        # Merge base params with rule params
                        all_params = {**base_params, **params}

                        # Three-level: not in deny/ask → allowed
                        if policy is None or perm_name not in policy.blocked_permissions:
                            return _permission_allow(
                                api_entry,
                                name=fw_name,
                                permission=perm_name,
                                params=all_params,
                                rule=rule_str,
                                rel_path=rel_path,
                            )
                        # Permission exists but not granted — record for
                        # DENY but keep checking other permissions.
                        if perm_name not in denied_perm_names:
                            denied_perm_names.append(perm_name)
                        if denied_match is None:
                            denied_match = (base, fw_name, upper_method, rel_path)

    if blocked_match is not None:
        blocked_base, blocked_name, blocked_rel_path, first_matched_api_entry, base_params = (
            blocked_match
        )
        # A non-granted permission matched — DENY takes priority over unknown.
        if denied_match is not None:
            return FirewallBlock(
                *denied_match,
                tuple(denied_perm_names),
                "permission_denied",
            )
        if malformed_policy_match is not None:
            return FirewallBlock(*malformed_policy_match, (), "malformed_network_policy")
        # No permission rule matched — this is an "unknown" endpoint.
        # "ask" is treated as "deny" at the proxy level (same as ask permissions).

        blocked_policy = compiled_network_policies.policies.get(blocked_name)
        if blocked_policy is None:
            return _unknown_allow(
                first_matched_api_entry,
                name=blocked_name,
                params=base_params,
                rel_path=blocked_rel_path,
            )
        if blocked_policy.unknown_policy_malformed:
            return FirewallBlock(
                blocked_base,
                blocked_name,
                upper_method,
                blocked_rel_path,
                (),
                "malformed_network_policy",
            )
        if blocked_policy.unknown_policy == "allow":
            return _unknown_allow(
                first_matched_api_entry,
                name=blocked_name,
                params=base_params,
                rel_path=blocked_rel_path,
            )
        return FirewallBlock(
            blocked_base,
            blocked_name,
            upper_method,
            blocked_rel_path,
            (),
            "unknown_endpoint",
        )
    return None
