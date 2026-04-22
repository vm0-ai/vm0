"""Firewall URL/host/path pattern matching functions.

Pure functions with no module-level state or I/O.
"""

from typing import NamedTuple

_SEGMENT_ERROR_HINT = 'use "{name}", "prefix{name}", "{name}suffix", or "prefix{name}suffix"'

# A segment with two or more ``{`` braces contains more than one parameter,
# which the grammar rejects — detected once here rather than scattering the
# literal ``2`` across the parser.
_MULTI_PARAM_BRACE_COUNT = 2

# Firewall rules are encoded as ``"METHOD path"`` — a single-whitespace-split
# yields exactly two tokens.  Rows that fail this shape are malformed.
_RULE_TOKEN_COUNT = 2


def parse_segment(seg: str) -> dict:
    """Parse a single host or path segment into literal / param / error.

    Grammar mirrors turbo/packages/core/src/contracts/segment-parser.ts —
    keep both implementations in lockstep. Any change to accepted or
    rejected forms must land in both languages at once.

    Returns one of:
      {"kind": "literal", "value": seg}
      {"kind": "param", "prefix": str, "name": str, "suffix": str,
       "greedy": "" | "+" | "*"}
      {"kind": "error", "reason": str}
    """
    open_count = seg.count("{")
    close_count = seg.count("}")

    if open_count == 0 and close_count == 0:
        return {"kind": "literal", "value": seg}
    if open_count != close_count:
        return {
            "kind": "error",
            "reason": f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}',
        }

    open1 = seg.find("{")
    close1 = seg.find("}")
    if close1 < open1:
        return {
            "kind": "error",
            "reason": f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}',
        }

    if open_count >= _MULTI_PARAM_BRACE_COUNT:
        open2 = seg.find("{", close1 + 1)
        if close1 + 1 == open2:
            return {
                "kind": "error",
                "reason": (
                    f'adjacent parameters in segment "{seg}" — only one parameter '
                    f"per segment is allowed; {_SEGMENT_ERROR_HINT}"
                ),
            }
        return {
            "kind": "error",
            "reason": (
                f'literal-separated parameters in segment "{seg}" — only one parameter '
                f"per segment is allowed; {_SEGMENT_ERROR_HINT}"
            ),
        }

    prefix = seg[:open1]
    content = seg[open1 + 1 : close1]
    suffix = seg[close1 + 1 :]

    if "{" in prefix or "}" in prefix or "{" in suffix or "}" in suffix:
        return {
            "kind": "error",
            "reason": f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}',
        }

    greedy = ""
    name = content
    if len(content) > 0 and content[-1] in ("+", "*"):
        greedy = content[-1]
        name = content[:-1]

    if len(name) == 0:
        return {
            "kind": "error",
            "reason": f'empty parameter name in segment "{seg}" — {_SEGMENT_ERROR_HINT}',
        }

    return {
        "kind": "param",
        "prefix": prefix,
        "name": name,
        "suffix": suffix,
        "greedy": greedy,
    }


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


class FirewallAllow(NamedTuple):
    """Permission matched — inject auth headers."""

    api_entry: dict
    match_info: dict


class FirewallBlock(NamedTuple):
    """Base URL matched but no permission granted — return 403."""

    base: str
    name: str
    method: str
    path: str
    permissions: tuple[str, ...]  # denied permission names; empty for unknown-endpoint blocks


def _build_block_set(
    fw_name: str,
    network_policies: dict,
) -> set:
    """Build a set of denied/asked permission names for a firewall name.

    Only reads ``deny`` and ``ask`` fields — the ``allow`` field is not
    consumed by the proxy (it exists for frontend display only).

    Returns empty set when name is absent from the map (fully permissive —
    consistent with the frontend contract where absent names are treated
    as all-granted + allow-unknown).
    """
    grant = network_policies.get(fw_name)
    if grant is None:
        return set()
    return set(grant.get("deny", [])) | set(grant.get("ask", []))


def _get_unknown_policy(
    fw_name: str,
    network_policies: dict,
) -> str:
    """Get the policy for unknown endpoints (no rule match).

    Returns "allow", "deny", or "ask".
    """
    grant = network_policies.get(fw_name)
    if grant is None:
        return "allow"
    return grant.get("unknownPolicy", "allow")


def match_firewall_request(
    url: str,
    method: str,
    vm_firewalls: list | None,
    network_policies: dict | None = None,
) -> FirewallAllow | FirewallBlock | None:
    """Match request against firewall permissions with three-level matching.

    Returns:
      FirewallAllow — granted permission matched or unknown endpoint allowed
      FirewallBlock — base URL matched but permission denied or unknown blocked
      None — no base URL match (not a firewall request)
    """
    if not vm_firewalls:
        return None

    if network_policies is None:
        network_policies = {}

    # Track the first base URL that matched for block/unknown responses.
    blocked_base = None
    blocked_name = ""
    blocked_rel_path = "/"
    # Track the first api_entry that matched base URL (for unknown endpoint auth)
    first_matched_api_entry = None
    first_matched_base_params: dict = {}

    upper_method = method.upper()

    # Track the first non-granted permission match — used for DENY when no
    # granted permission matches.  We record it instead of returning immediately
    # because a later permission may be granted for the same endpoint.
    denied_match: tuple[str, str, str, str] | None = None  # (base, name, method, path)
    denied_perm_names: list[str] = []

    for fw_entry in vm_firewalls:
        fw_name = fw_entry.get("name", "")
        block_set = _build_block_set(fw_name, network_policies)

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
                blocked_name = fw_name
                blocked_rel_path = rel_path
                first_matched_api_entry = api_entry
                first_matched_base_params = base_params

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
                        if perm_name not in block_set:
                            return FirewallAllow(
                                api_entry,
                                {
                                    "name": fw_name,
                                    "permission": perm_name,
                                    "params": all_params,
                                    "rule": rule_str,
                                    "rel_path": rel_path,
                                },
                            )
                        # Permission exists but not granted — record for
                        # DENY but keep checking other permissions.
                        if perm_name not in denied_perm_names:
                            denied_perm_names.append(perm_name)
                        if denied_match is None:
                            denied_match = (base, fw_name, upper_method, rel_path)

    if blocked_base is not None:
        # A non-granted permission matched — DENY takes priority over unknown.
        if denied_match is not None:
            return FirewallBlock(*denied_match, tuple(denied_perm_names))
        # No permission rule matched — this is an "unknown" endpoint.
        # "ask" is treated as "deny" at the proxy level (same as ask permissions).
        if _get_unknown_policy(blocked_name, network_policies) == "allow":
            return FirewallAllow(
                first_matched_api_entry,
                {
                    "name": blocked_name,
                    "permission": "",
                    "params": first_matched_base_params,
                    "rule": "",
                    "rel_path": blocked_rel_path,
                },
            )
        return FirewallBlock(blocked_base, blocked_name, upper_method, blocked_rel_path, ())
    return None
