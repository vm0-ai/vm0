"""Firewall URL/host/path pattern matching functions.

Pure functions with no module-level state or I/O.
"""

import json
from typing import NamedTuple


def match_host(host: str, pattern: str) -> dict | None:
    """Match a hostname against a pattern. Returns extracted params or None.

    Segments are `.`-delimited. Since subdomains grow leftward, greedy params
    ({name+}, {name*}) must appear in the first (leftmost) position.

    - Literal segments must match exactly (case-insensitive).
    - {name} matches a single host segment.
    - {name+} matches one or more leading host segments. Must be first.
    - {name*} matches zero or more leading host segments. Must be first.
    """
    host_segs = host.lower().split(".")
    # Keep original pattern segments for param name extraction;
    # only lowercase for literal comparison.
    pattern_segs_orig = pattern.split(".")

    params: dict[str, str] = {}

    # Match right-to-left: reverse both, then match like a path.
    host_segs.reverse()
    pattern_segs_orig.reverse()

    hi = 0
    for seg_orig in pattern_segs_orig:
        if seg_orig.startswith("{") and seg_orig.endswith("}"):
            name = seg_orig[1:-1]
            if name.endswith("+"):
                # Greedy: consume rest (one or more)
                if hi >= len(host_segs):
                    return None
                remaining = list(reversed(host_segs[hi:]))
                params[name[:-1]] = ".".join(remaining)
                return params
            if name.endswith("*"):
                # Greedy: consume rest (zero or more)
                remaining = list(reversed(host_segs[hi:]))
                params[name[:-1]] = ".".join(remaining)
                return params
            # Single segment
            if hi >= len(host_segs):
                return None
            params[name] = host_segs[hi]
            hi += 1
        else:
            if hi >= len(host_segs) or host_segs[hi] != seg_orig.lower():
                return None
            hi += 1

    if hi != len(host_segs):
        return None
    return params


def match_path_prefix(path_segs: list[str], pattern_segs: list[str]) -> tuple[dict, int] | None:
    """Match pattern segments against the beginning of path segments.

    Unlike match_path(), does NOT require full path consumption.
    Does NOT support greedy params (not allowed in base URL paths).

    Returns (params, consumed_count) on match, None on no match.
    """
    params: dict[str, str] = {}
    pi = 0

    for seg in pattern_segs:
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1]
            if pi >= len(path_segs):
                return None
            params[name] = path_segs[pi]
            pi += 1
        else:
            if pi >= len(path_segs) or path_segs[pi] != seg:
                return None
            pi += 1

    return params, pi


def match_base_url(url: str, base: str) -> tuple[str, dict] | None:
    """Match a request URL against a (possibly parameterized) base URL.

    Returns (rel_path, params) on match, None on no match.
    - rel_path: the path after the base (for permission rule matching)
    - params: extracted parameters from the base URL
    """
    # Fast path: no parameters — use simple prefix matching
    if "{" not in base:
        base_stripped = base.rstrip("/")
        if not url.startswith(base_stripped):
            return None
        rest = url[len(base_stripped) :]
        if rest and rest[0] not in ("/", "?", "#"):
            return None
        rel_path = rest.split("?")[0].split("#")[0] or "/"
        return rel_path, {}

    # Parameterized base URL: parse into scheme, host pattern, path pattern
    scheme_end = base.find("://")
    if scheme_end == -1:
        return None
    scheme = base[: scheme_end + 3]  # e.g., "https://"

    # Request must start with same scheme
    if not url.lower().startswith(scheme.lower()):
        return None

    base_rest = base[scheme_end + 3 :]  # after "://"
    url_rest = url[scheme_end + 3 :]

    # Split host from path
    base_slash = base_rest.find("/")
    base_host = base_rest if base_slash == -1 else base_rest[:base_slash]
    base_path = "" if base_slash == -1 else base_rest[base_slash:]

    url_slash = url_rest.find("/")
    url_host_with_port = url_rest if url_slash == -1 else url_rest[:url_slash]
    url_path = "" if url_slash == -1 else url_rest[url_slash:]

    # Match host directly — do NOT strip port. Non-standard ports (e.g., :8443)
    # are included in URLs by get_original_url() and must NOT match base patterns
    # without an explicit port, otherwise auth headers could leak to rogue servers.
    # Standard ports (443 for https, 80 for http) are omitted from URLs by
    # get_original_url(), so they match naturally.
    host_params = match_host(url_host_with_port, base_host)
    if host_params is None:
        return None

    # Strip query/fragment from URL path
    clean_url_path = url_path.split("?")[0].split("#")[0]

    # Match base path prefix
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
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1]
            if name.endswith("+"):
                # Greedy: consume rest of path (one or more segments)
                if pi >= len(path_segs):
                    return None
                params[name[:-1]] = "/".join(path_segs[pi:])
                return params
            if name.endswith("*"):
                # Greedy: consume rest of path (zero or more segments)
                params[name[:-1]] = "/".join(path_segs[pi:])
                return params
            # Single segment
            if pi >= len(path_segs):
                return None
            params[name] = path_segs[pi]
            pi += 1
        else:
            if pi >= len(path_segs) or path_segs[pi] != seg:
                return None
            pi += 1

    # All pattern segments consumed; path must also be fully consumed
    if pi != len(path_segs):
        return None
    return params


class FirewallAllow(NamedTuple):
    """Permission matched — inject auth headers."""

    api_entry: dict
    match_info: dict


class FirewallBlock(NamedTuple):
    """Base URL matched but no permission granted — return 403."""

    base: str
    ref: str
    name: str
    method: str
    path: str


def parse_graphql_rule(rest: str) -> tuple[str, str | None, str | None, str | None] | None:
    """Parse a rule's path+suffix into (path, type_filter, op_filter, field_filter).

    If the rule contains the ``GraphQL`` keyword, returns the path portion
    and optional ``type:`` / ``operationName:`` / ``field:`` filters.
    Returns None when the ``GraphQL`` keyword is absent (plain REST rule).
    """
    gql_idx = rest.find(" GraphQL")
    if gql_idx == -1:
        return None

    path = rest[:gql_idx] if gql_idx > 0 else "/"
    suffix_parts = rest[gql_idx + 1 :].split()  # ["GraphQL", "type:query", ...]

    type_filter: str | None = None
    op_filter: str | None = None
    field_filter: str | None = None

    for part in suffix_parts[1:]:  # skip "GraphQL" itself
        if part.startswith("type:"):
            type_filter = part[5:]
        elif part.startswith("operationName:"):
            op_filter = part[14:]
        elif part.startswith("field:"):
            field_filter = part[6:]

    return path, type_filter, op_filter, field_filter


def _skip_string(s: str, i: int) -> int:
    """Advance past a quoted string (handles escape sequences and block strings)."""
    # Block string: """..."""
    if s[i : i + 3] == '"""':
        i += 3
        while i < len(s):
            if s[i : i + 3] == '"""':
                return i + 3
            i += 1
        return i
    # Regular string: "..."
    quote = s[i]
    i += 1
    while i < len(s):
        if s[i] == "\\":
            i += 2  # skip escaped character
        elif s[i] == quote:
            return i + 1
        else:
            i += 1
    return i


def _skip_comment(s: str, i: int) -> int:
    """Advance past a line comment (# to end of line)."""
    while i < len(s) and s[i] != "\n":
        i += 1
    return i


def _skip_spread(s: str, i: int) -> int:
    """Advance past a fragment spread (...Name) or inline fragment (... on Type)."""
    i += 3  # skip "..."
    while i < len(s) and s[i].isspace():
        i += 1
    # Read first identifier (fragment name, or "on" for inline fragments)
    j = i
    while j < len(s) and (s[j].isalnum() or s[j] == "_"):
        j += 1
    ident = s[i:j]
    i = j
    # If it was "on", also skip the type name
    if ident == "on":
        while i < len(s) and s[i].isspace():
            i += 1
        while i < len(s) and (s[i].isalnum() or s[i] == "_"):
            i += 1
    return i


def _skip_parens(s: str, i: int) -> int:
    """Advance past balanced parentheses, respecting strings and comments."""
    depth = 1
    i += 1  # skip opening '('
    while i < len(s) and depth > 0:
        c = s[i]
        if c == "(":
            depth += 1
            i += 1
        elif c == ")":
            depth -= 1
            i += 1
        elif c == '"':
            i = _skip_string(s, i)
        elif c == "#":
            i = _skip_comment(s, i)
        else:
            i += 1
    return i


def _extract_top_level_fields(query_str: str) -> list[str]:
    """Extract top-level selection field names from a GraphQL query string.

    Parses just enough to find the operation body's opening brace and then
    extracts identifiers at brace-depth 1.  Handles aliases
    (``alias: fieldName``) by returning the field name, not the alias.

    Properly skips string literals and parenthesized argument lists so that
    values inside arguments cannot be mistaken for field names.
    """
    s = query_str.lstrip()
    if not s:
        return []

    i = 0

    # Skip operation keyword (query/mutation/subscription)
    if s[0].isalpha():
        while i < len(s) and s[i].isalpha():
            i += 1
        # Skip optional operation name
        while i < len(s) and s[i].isspace():
            i += 1
        if i < len(s) and (s[i].isalpha() or s[i] == "_"):
            while i < len(s) and (s[i].isalnum() or s[i] == "_"):
                i += 1
            while i < len(s) and s[i].isspace():
                i += 1
        # Skip optional variable definitions: ($var: Type, ...)
        if i < len(s) and s[i] == "(":
            i = _skip_parens(s, i)
            while i < len(s) and s[i].isspace():
                i += 1

    # Skip optional directives (@skip, @include, etc.) before opening brace
    while i < len(s) and s[i] == "@":
        while i < len(s) and not s[i].isspace() and s[i] not in ("{", "("):
            i += 1
        if i < len(s) and s[i] == "(":
            i = _skip_parens(s, i)
        while i < len(s) and s[i].isspace():
            i += 1

    # Find opening brace of selection set
    if i >= len(s) or s[i] != "{":
        return []
    i += 1  # skip '{'

    fields: list[str] = []
    depth = 1

    while i < len(s) and depth > 0:
        c = s[i]
        if c == "{":
            depth += 1
            i += 1
        elif c == "}":
            depth -= 1
            i += 1
        elif c == '"':
            i = _skip_string(s, i)
        elif c == "#":
            i = _skip_comment(s, i)
        elif c == "(":
            i = _skip_parens(s, i)
        elif c == "." and i + 2 < len(s) and s[i + 1] == "." and s[i + 2] == ".":
            i = _skip_spread(s, i)
        elif depth == 1 and (c.isalpha() or c == "_"):
            # Read identifier
            j = i
            while j < len(s) and (s[j].isalnum() or s[j] == "_"):
                j += 1
            ident = s[i:j]
            i = j
            # Skip whitespace
            while i < len(s) and s[i].isspace():
                i += 1
            # Check if this is an alias (followed by ':')
            if i < len(s) and s[i] == ":":
                i += 1  # skip ':'
                while i < len(s) and s[i].isspace():
                    i += 1
                # Read the actual field name
                j = i
                while j < len(s) and (s[j].isalnum() or s[j] == "_"):
                    j += 1
                if j > i:
                    fields.append(s[i:j])
                i = j
            else:
                fields.append(ident)
        else:
            i += 1

    return fields


def _match_wildcard(value: str, pattern: str) -> bool:
    """Match a value against a pattern with optional trailing wildcard."""
    if pattern.endswith("*"):
        return value.startswith(pattern[:-1])
    return value == pattern


def match_graphql_body(
    body: bytes | None,
    type_filter: str | None,
    op_filter: str | None,
    field_filter: str | None = None,
) -> bool:
    """Match a GraphQL request body against type, operationName, and field filters.

    Fail-closed: returns False if the body cannot be parsed or required
    fields are missing.
    """
    if not body:
        return False

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False

    if not isinstance(data, dict):
        return False

    # Extract query string early if any filter needs it.
    query_str: str | None = None
    if type_filter is not None or field_filter is not None:
        raw = data.get("query")
        if not isinstance(raw, str):
            return False
        query_str = raw

    # Extract operation type from the query string.
    # GraphQL allows compact forms like `mutation{`, `query($id: ID!)`,
    # so we extract only leading alpha characters as the keyword.
    if type_filter is not None and query_str is not None:
        stripped = query_str.lstrip()
        if not stripped:
            return False
        # Extract leading alphabetic chars: "mutation(" → "mutation"
        end = 0
        while end < len(stripped) and stripped[end].isalpha():
            end += 1
        keyword = stripped[:end].lower() if end > 0 else "query"
        if keyword != type_filter:
            return False

    # Match operationName
    if op_filter is not None:
        op_name = data.get("operationName")
        if not isinstance(op_name, str) or not op_name:
            return False
        if not _match_wildcard(op_name, op_filter):
            return False

    # Match field name
    if field_filter is not None and query_str is not None:
        fields = _extract_top_level_fields(query_str)
        if not fields:
            return False
        if not any(_match_wildcard(f, field_filter) for f in fields):
            return False

    return True


def match_firewall_request(
    url: str,
    method: str,
    vm_firewalls: list | None,
    body: bytes | None = None,
) -> FirewallAllow | FirewallBlock | None:
    """Match request against firewall permissions.

    Returns:
      FirewallAllow — permission matched, inject headers
      FirewallBlock — base URL matched but no permission granted
      None — no base URL match (not a firewall request)
    """
    if not vm_firewalls:
        return None

    # Track the first base URL that matched. If we find a base match but no
    # permission rule allows the request, we block it (fail-closed). Only the
    # first matched base is recorded — subsequent base matches don't overwrite.
    blocked_base = None
    blocked_ref = ""
    blocked_name = ""

    upper_method = method.upper()

    # Track the relative path of the first blocked base for error messages
    blocked_rel_path = "/"

    for fw_entry in vm_firewalls:
        fw_name = fw_entry.get("name", "")
        fw_ref = fw_entry.get("ref", "")
        for api_entry in fw_entry.get("apis", []):
            base = api_entry.get("base", "").rstrip("/")
            if not base:
                continue

            base_result = match_base_url(url, base)
            if base_result is None:
                continue

            rel_path, base_params = base_result

            # Base URL matched
            if blocked_base is None:
                blocked_base = base
                blocked_ref = fw_ref
                blocked_name = fw_name
                blocked_rel_path = rel_path

            permissions = api_entry.get("permissions")
            if not permissions:
                # No permissions defined or empty → block (fail-closed)
                continue

            for perm in permissions:
                perm_name = perm.get("name", "")
                for rule_str in perm.get("rules", []):
                    parts = rule_str.split(" ", 1)
                    if len(parts) != 2:
                        continue
                    rule_method = parts[0].upper()
                    rest = parts[1]
                    if rule_method != "ANY" and rule_method != upper_method:
                        continue

                    # Check for GraphQL suffix
                    gql = parse_graphql_rule(rest)
                    if gql is not None:
                        rule_pattern, type_filter, op_filter, field_filter = gql
                    else:
                        rule_pattern = rest
                        type_filter, op_filter, field_filter = None, None, None

                    params = match_path(rel_path, rule_pattern)
                    if params is not None:
                        # If GraphQL rule, also check body
                        has_gql_filter = (
                            type_filter is not None
                            or op_filter is not None
                            or field_filter is not None
                        )
                        if has_gql_filter and not match_graphql_body(
                            body, type_filter, op_filter, field_filter
                        ):
                            continue
                        # Merge base params with rule params
                        all_params = {**base_params, **params}
                        return FirewallAllow(
                            api_entry,
                            {
                                "name": fw_name,
                                "ref": fw_ref,
                                "permission": perm_name,
                                "params": all_params,
                                "rule": rule_str,
                                "rel_path": rel_path,
                            },
                        )

    if blocked_base is not None:
        return FirewallBlock(
            blocked_base, blocked_ref, blocked_name, upper_method, blocked_rel_path
        )
    return None
