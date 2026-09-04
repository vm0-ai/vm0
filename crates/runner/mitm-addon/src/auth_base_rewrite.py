"""Auth.base URL rewriting and trusted-query validation.

Pure functions with no module-level state or I/O.

Auth.base performs its own safe percent-decoding and URL validation before
forwarding credential-bearing requests; those rules remain local to this module.
"""

import urllib.parse

from authority_utils import (
    authority_has_empty_port,
    bracketed_authority_host_is_ipv6,
    format_url_host,
    percent_decode_host,
    raw_authority_host,
)
from host_normalization import normalize_hostname
from path_security import has_unsafe_path
from runtime_url_parsing import split_runtime_url
from url_syntax import (
    has_raw_whitespace,
    has_unsafe_url_codepoint,
    strip_optional_terminal_slash,
)

_PERCENT_DECODED_HOST_SYNTAX_CHARS = frozenset("{}.\u3002\uff0e\uff61,")
_URL_PATH_SAFE_CHARS = "/%:@!$&'()*+,;="
_URL_QUERY_SAFE_CHARS = "/?%:@!$&'()*+,;="
_VALID_AUTH_BASE_SCHEME = "https"

# Bound the complete resolved value before synchronous URL processing on the
# mitmproxy event loop. This matches the connector-check URL ceiling while
# retaining ample room for ordinary connector URLs.
MAX_RESOLVED_AUTH_BASE_CHARACTERS = 8 * 1024
# This matches the runner's existing managed-query work scale while retaining
# ample room for ordinary connector URLs. Count every segment that auth.base
# materializes, including empty segments separated by either ``&`` or ``;``.
MAX_AUTH_BASE_QUERY_PAIRS = 8 * 1024


class AuthBaseQueryTooManyPairsError(ValueError):
    """The aggregate auth.base rewrite query exceeds its pair work budget."""


_QueryPair = tuple[str, str]


def _split_query_pairs(query: str) -> list[_QueryPair]:
    if not query:
        return []
    pairs: list[_QueryPair] = []
    separator = ""
    start = 0
    for index, char in enumerate(query):
        if char in ("&", ";"):
            pairs.append((separator, query[start:index]))
            separator = char
            start = index + 1
    pairs.append((separator, query[start:]))
    return pairs


def _query_pair_key(pair: _QueryPair) -> str:
    _, raw_pair = pair
    raw_key, _, _ = raw_pair.partition("=")
    return urllib.parse.unquote_plus(raw_key)


def _query_pair_keys(pairs: list[_QueryPair]) -> set[str]:
    return {_query_pair_key(pair) for pair in pairs if pair[1]}


def _filter_query_pairs(
    pairs: list[_QueryPair],
    blocked_keys: set[str],
) -> list[_QueryPair]:
    if not blocked_keys:
        return pairs
    filtered: list[_QueryPair] = []
    removed_since_last_kept = False
    for separator, raw_pair in pairs:
        if not raw_pair:
            if not removed_since_last_kept:
                filtered.append((separator, raw_pair))
            continue
        if _query_pair_key((separator, raw_pair)) in blocked_keys:
            while filtered and not filtered[-1][1]:
                filtered.pop()
            removed_since_last_kept = True
            continue
        if removed_since_last_kept and filtered:
            separator = "&"
        filtered.append((separator, raw_pair))
        removed_since_last_kept = False
    return filtered


def _join_query_pairs(pairs: list[_QueryPair]) -> str:
    query_parts: list[str] = []
    for index, (separator, raw_pair) in enumerate(pairs):
        if index == 0:
            query_parts.append(raw_pair)
            continue
        query_parts.append(f"{separator or '&'}{raw_pair}")
    return "".join(query_parts)


def _drop_leading_separator(pairs: list[_QueryPair]) -> list[_QueryPair]:
    if not pairs:
        return []
    _, raw_pair = pairs[0]
    return [("", raw_pair), *pairs[1:]]


def _join_query_sources(*sources: list[_QueryPair]) -> str:
    source_queries = [
        _join_query_pairs(_drop_leading_separator(source)) for source in sources if source
    ]
    return "&".join(query for query in source_queries if query)


def _encode_query_pairs(query: dict[str, str] | None) -> list[_QueryPair]:
    if not query:
        return []
    return _split_query_pairs(urllib.parse.urlencode(query))


def _consume_query_pair_budget(query: str, remaining_pairs: int) -> int:
    if not query:
        return remaining_pairs

    remaining_pairs -= 1
    if remaining_pairs < 0:
        raise AuthBaseQueryTooManyPairsError("auth.base rewritten query has too many pairs")
    for char in query:
        if char in ("&", ";"):
            remaining_pairs -= 1
            if remaining_pairs < 0:
                raise AuthBaseQueryTooManyPairsError("auth.base rewritten query has too many pairs")
    return remaining_pairs


def _validate_rewrite_query_pair_count(
    base_query: str,
    orig_query: str,
    resolved_query: dict[str, str] | None,
) -> None:
    remaining_pairs = MAX_AUTH_BASE_QUERY_PAIRS - len(resolved_query or {})
    if remaining_pairs < 0:
        raise AuthBaseQueryTooManyPairsError("auth.base rewritten query has too many pairs")

    remaining_pairs = _consume_query_pair_budget(orig_query, remaining_pairs)
    _consume_query_pair_budget(base_query, remaining_pairs)


def _merge_rewrite_query(
    base_query: str,
    orig_query: str,
    resolved_query: dict[str, str] | None,
) -> str:
    if not base_query and not resolved_query:
        return orig_query

    _validate_rewrite_query_pair_count(base_query, orig_query, resolved_query)
    base_pairs = _split_query_pairs(base_query)
    orig_pairs = _split_query_pairs(orig_query)
    auth_keys = set(resolved_query or {})

    filtered_base_pairs = _filter_query_pairs(base_pairs, auth_keys)
    blocked_orig_keys = auth_keys | _query_pair_keys(filtered_base_pairs)
    filtered_orig_pairs = _filter_query_pairs(orig_pairs, blocked_orig_keys)
    auth_pairs = _encode_query_pairs(resolved_query)

    return _join_query_sources(filtered_base_pairs, filtered_orig_pairs, auth_pairs)


def _percent_decode_host(host: str) -> str:
    decoded = percent_decode_host(host, syntax_chars=_PERCENT_DECODED_HOST_SYNTAX_CHARS)
    if decoded.invalid_encoding:
        raise ValueError("Invalid auth.base URL: host has invalid percent encoding")
    if decoded.decoded_syntax:
        raise ValueError("Invalid auth.base URL: host has unsafe percent encoding")
    return decoded.value


def _raw_rewrite_base_host(netloc: str) -> str | None:
    raw_host = raw_authority_host(netloc)
    return raw_host.hostname if raw_host is not None else None


def _validated_rewrite_base(resolved_base: str) -> tuple[urllib.parse.SplitResult, str]:
    if len(resolved_base) > MAX_RESOLVED_AUTH_BASE_CHARACTERS:
        raise ValueError(
            f"Invalid auth.base URL: must not exceed {MAX_RESOLVED_AUTH_BASE_CHARACTERS} characters"
        )
    if "\\" in resolved_base:
        raise ValueError("Invalid auth.base URL: must not contain backslash")
    if has_raw_whitespace(resolved_base):
        raise ValueError("Invalid auth.base URL: must not contain whitespace")
    if has_unsafe_url_codepoint(resolved_base):
        raise ValueError(
            "Invalid auth.base URL: must not contain control characters or invalid Unicode"
        )

    parsed = split_runtime_url(resolved_base)
    if parsed.scheme.lower() != _VALID_AUTH_BASE_SCHEME:
        raise ValueError("Invalid auth.base URL: scheme must be https")
    if not parsed.netloc:
        raise ValueError("Invalid auth.base URL: missing host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Invalid auth.base URL: userinfo is not allowed")
    if not bracketed_authority_host_is_ipv6(parsed.netloc):
        raise ValueError("Invalid auth.base URL: invalid host")
    if authority_has_empty_port(parsed.netloc):
        raise ValueError("Invalid auth.base URL: invalid port")
    if parsed.fragment:
        raise ValueError("Invalid auth.base URL: must not contain fragment")
    if has_unsafe_path(parsed.path):
        raise ValueError("Invalid auth.base URL: unsafe path syntax is not allowed")

    host = _raw_rewrite_base_host(parsed.netloc)
    if host is None:
        raise ValueError("Invalid auth.base URL: missing host")
    decoded_host = _percent_decode_host(host)
    try:
        normalized_host = normalize_hostname(decoded_host)
    except (UnicodeError, ValueError) as exc:
        raise ValueError("Invalid auth.base URL: invalid host") from exc
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    authority = format_url_host(normalized_host)
    if port is not None:
        authority = f"{authority}:{port}"
    return parsed, authority


def _quote_url_part(value: str, safe: str) -> str:
    try:
        return urllib.parse.quote(value, safe=safe, encoding="utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError("Invalid auth.base URL: contains invalid unicode") from exc


def build_rewrite_url(
    resolved_base: str,
    rel_path: str,
    orig_query: str,
    resolved_query: dict[str, str] | None = None,
) -> str:
    """Build the final URL for auth.base URL rewriting.

    Combines the resolved base URL (with credentials in path), the relative
    path from the firewall match, and query strings from trusted auth data
    and the original request. ``orig_query`` is the raw query string of the
    incoming request (no leading ``?``). Query key precedence is
    ``resolved_query`` > resolved base query > original request query.

    ``resolved_base`` must contain at most
    ``MAX_RESOLVED_AUTH_BASE_CHARACTERS`` characters and be an absolute HTTPS
    URL with a valid authority and safe path; userinfo and fragments are not
    allowed. Backslashes, whitespace or unsafe code points, invalid ports,
    unsafe path syntax, malformed Unicode, and unsafe or invalid percent-encoded
    host syntax are rejected. Accepted hosts are normalized for forwarding:
    Unicode and safely percent-encoded Unicode names use canonical IDNA form,
    IPv4 literals must be canonical dotted quads after safe percent-decoding,
    IPv6 literals are compressed and bracketed, and explicit valid ports are
    preserved.

    Unsafe path syntax in ``rel_path`` is rejected as an invariant; firewall
    matching should already have blocked it before auth is applied.

    Trusted-query rewrites accept at most ``MAX_AUTH_BASE_QUERY_PAIRS``
    aggregate query segments across the resolved base, original request, and
    resolved auth data. Query-free trusted sources retain the original query
    without segment inspection.

    Raises:
        AuthBaseQueryTooManyPairsError: If a trusted-query rewrite exceeds the
            aggregate query pair work budget.
        ValueError: If ``resolved_base`` is not a safe absolute HTTPS URL,
            ``rel_path`` has unsafe path syntax, or a URL component contains
            Unicode that cannot be safely encoded.
    """
    if has_unsafe_path(rel_path):
        raise ValueError("Unsafe rewrite path: unsafe path syntax is not allowed")

    base_parsed, base_authority = _validated_rewrite_base(resolved_base)

    # Append rel_path to the base path portion
    base_path = (
        strip_optional_terminal_slash(base_parsed.path) + rel_path
        if rel_path != "/"
        else base_parsed.path
    )

    merged_qs = _merge_rewrite_query(base_parsed.query, orig_query, resolved_query)
    encoded_base_path = _quote_url_part(base_path, _URL_PATH_SAFE_CHARS)
    encoded_query = _quote_url_part(merged_qs, _URL_QUERY_SAFE_CHARS)

    return urllib.parse.urlunsplit(
        (base_parsed.scheme, base_authority, encoded_base_path, encoded_query, "")
    )
