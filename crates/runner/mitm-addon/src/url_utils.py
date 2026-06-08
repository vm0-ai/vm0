"""URL reconstruction and rewriting utilities.

Pure functions with no module-level state or I/O.

Trusted request authority validation and auth.base rewrite validation share
low-level host canonicalization primitives, but they are different trust
boundaries: Host/SNI input must not accept percent-encoded authority syntax,
while auth.base targets reject unsafe percent-encoded host syntax before
forwarding credential-bearing requests.
"""

import ipaddress
import urllib.parse
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http

from authority_utils import (
    IPV6_VERSION,
    format_url_host,
    has_ascii_space_or_control,
    is_default_scheme_port,
    parse_authority_port,
    percent_decode_host,
)
from host_normalization import normalize_idna_hostname
from path_security import has_unsafe_path
from url_syntax import (
    has_raw_whitespace,
    has_unsafe_url_codepoint,
    strip_optional_terminal_slash,
)

_FORBIDDEN_HOST_CHARS = frozenset("#%,/<>?@[\\]^|{}")
_PERCENT_DECODED_HOST_SYNTAX_CHARS = frozenset("{}.\u3002\uff0e\uff61,")
_URL_PATH_SAFE_CHARS = "/%:@!$&'()*+,;="
_URL_QUERY_SAFE_CHARS = "/?%:@!$&'()*+,;="
_VALID_AUTH_BASE_SCHEME = "https"


@dataclass(frozen=True)
class TrustedAuthority:
    """Authority components trusted by firewall/auth decisions.

    For HTTPS, ``host`` is the normalized TLS SNI after Host/``:authority``
    validation. For non-HTTPS traffic, ``host`` is the transparent destination
    because there is no SNI binding. ``url`` is the reconstructed URL used by
    firewall matching and credential injection.
    """

    host: str
    port: int
    url: str


AuthorityValidationReason = Literal[
    "missing_sni",
    "invalid_sni",
    "missing_authority",
    "invalid_authority",
    "authority_mismatch",
    "authority_port_mismatch",
]


class AuthorityValidationError(Exception):
    """HTTPS authority validation failure with a public diagnostic reason.

    ``reason`` is exposed in proxy logs as ``reason``, network logs as
    ``firewall_error``, and the 403 JSON response body as ``error``.

    Valid reason values:
    - ``missing_sni``: the HTTPS request had no TLS SNI.
    - ``invalid_sni``: the TLS SNI failed hostname normalization.
    - ``missing_authority``: the HTTPS request had no Host/``:authority``.
    - ``invalid_authority``: Host/``:authority`` failed parsing or normalization.
    - ``authority_mismatch``: the Host hostname did not match TLS SNI.
    - ``authority_port_mismatch``: the Host port did not match destination port.
    """

    def __init__(
        self,
        reason: AuthorityValidationReason,
        *,
        message: str,
        sni: str | None,
        request_host: str,
        host_header: str | None,
        request_port: int,
        fallback_url: str,
    ) -> None:
        super().__init__(message)
        self.reason: AuthorityValidationReason = reason
        self.message = message
        self.sni = sni
        self.request_host = request_host
        self.host_header = host_header
        self.request_port = request_port
        self.fallback_url = fallback_url


def _has_invalid_hostname_chars(host: str) -> bool:
    return has_ascii_space_or_control(host) or any(char in _FORBIDDEN_HOST_CHARS for char in host)


def _normalize_hostname(host: str) -> str:
    if ":" in host:
        if "%" in host:
            raise ValueError("IPv6 scope identifiers are not allowed")
        try:
            parsed = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError("invalid IPv6 hostname") from exc
        if parsed.version == IPV6_VERSION:
            return parsed.compressed.lower()
        raise ValueError("colon host must be IPv6")
    if _has_invalid_hostname_chars(host):
        raise ValueError("invalid hostname")
    return normalize_idna_hostname(host)


def _host_with_port(scheme: str, host: str, port: int) -> str:
    url_host = format_url_host(host)
    if scheme in ("http", "https") and not is_default_scheme_port(scheme, port):
        return f"{url_host}:{port}"
    return url_host


def _build_url(scheme: str, host: str, port: int, path: str) -> str:
    return f"{scheme}://{_host_with_port(scheme, host, port)}{path}"


def _parse_host_authority(authority: str) -> tuple[str, int | None]:
    if not authority or has_ascii_space_or_control(authority):
        raise ValueError("invalid authority")

    if authority.startswith("["):
        close_index = authority.find("]")
        if close_index == -1:
            raise ValueError("invalid IPv6 authority")
        host = authority[1:close_index]
        rest = authority[close_index + 1 :]
        if rest == "":
            port = None
        elif rest.startswith(":"):
            port = parse_authority_port(rest[1:])
        else:
            raise ValueError("invalid IPv6 authority")
        if "%" in host:
            raise ValueError("IPv6 scope identifiers are not allowed")
        parsed = ipaddress.ip_address(host)
        if parsed.version != IPV6_VERSION:
            raise ValueError("bracketed authority must be IPv6")
        return host, port

    if any(char in _FORBIDDEN_HOST_CHARS or char == "," for char in authority):
        raise ValueError("invalid host authority")
    if authority.count(":") > 1:
        raise ValueError("unbracketed IPv6 authority")
    if ":" not in authority:
        return authority, None

    host, raw_port = authority.rsplit(":", maxsplit=1)
    if not host:
        raise ValueError("missing authority host")
    return host, parse_authority_port(raw_port)


def get_trusted_authority(flow: http.HTTPFlow) -> TrustedAuthority:
    """Resolve the authority trusted for firewall/auth decisions.

    In transparent mode, mitmproxy's request host is the ``SO_ORIGINAL_DST``
    destination. For HTTPS, the TLS SNI is the domain authority used for
    upstream TLS, while Host/``:authority`` is only a client assertion. Require
    the HTTP authority to agree with SNI before using the URL for firewall
    matching or credential injection. For non-HTTPS traffic there is no SNI
    binding, so use the transparent destination host and do not trust Host.

    HTTPS validation failures raise ``AuthorityValidationError`` with one of
    the documented ``AuthorityValidationReason`` values.
    """
    scheme = flow.request.scheme
    port = flow.request.port
    path = flow.request.path
    host_header = flow.request.host_header
    request_host = flow.request.host

    if scheme != "https":
        return TrustedAuthority(
            host=request_host,
            port=port,
            url=_build_url(scheme, request_host, port, path),
        )

    raw_sni = getattr(flow.client_conn, "sni", None)
    sni = raw_sni.strip() if isinstance(raw_sni, str) else None

    def _authority_validation_error(
        reason: AuthorityValidationReason,
        *,
        message: str,
        fallback_url: str,
    ) -> AuthorityValidationError:
        return AuthorityValidationError(
            reason,
            message=message,
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=fallback_url,
        )

    if not sni:
        raise _authority_validation_error(
            "missing_sni",
            message="Request blocked: HTTPS request is missing TLS SNI",
            fallback_url=_build_url(scheme, request_host, port, path),
        )

    try:
        normalized_sni = _normalize_hostname(sni)
    except (UnicodeError, ValueError):
        raise _authority_validation_error(
            "invalid_sni",
            message="Request blocked: HTTPS request has invalid TLS SNI",
            fallback_url=_build_url(scheme, request_host, port, path),
        ) from None

    trusted_url = _build_url(scheme, normalized_sni, port, path)
    if not host_header:
        raise _authority_validation_error(
            "missing_authority",
            message="Request blocked: HTTPS request is missing Host authority",
            fallback_url=trusted_url,
        )

    try:
        header_host, header_port = _parse_host_authority(host_header)
        normalized_header_host = _normalize_hostname(header_host)
    except (UnicodeError, ValueError):
        raise _authority_validation_error(
            "invalid_authority",
            message="Request blocked: HTTPS request has invalid Host authority",
            fallback_url=trusted_url,
        ) from None

    if normalized_header_host != normalized_sni:
        raise _authority_validation_error(
            "authority_mismatch",
            message="Request blocked: Host authority does not match TLS SNI",
            fallback_url=trusted_url,
        )

    if header_port is not None and header_port != port:
        raise _authority_validation_error(
            "authority_port_mismatch",
            message="Request blocked: Host authority port does not match destination port",
            fallback_url=trusted_url,
        )

    return TrustedAuthority(host=normalized_sni, port=port, url=trusted_url)


def get_original_url(flow: http.HTTPFlow) -> str:
    """Reconstruct the original target URL from the request.

    Uses the trusted authority for HTTPS firewall/auth decisions. ``pretty_url``
    is intentionally not used: it takes the port from the Host header, so a
    request to ``host:8443`` with a plain ``Host: host`` (no port) would lose
    the ``:8443`` and break firewall rule matching.
    """
    return get_trusted_authority(flow).url


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


def _merge_rewrite_query(
    base_query: str,
    orig_query: str,
    resolved_query: dict[str, str] | None,
) -> str:
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


def _validated_rewrite_base(resolved_base: str) -> tuple[urllib.parse.SplitResult, str]:
    if "\\" in resolved_base:
        raise ValueError("Invalid auth.base URL: must not contain backslash")
    if has_raw_whitespace(resolved_base):
        raise ValueError("Invalid auth.base URL: must not contain whitespace")
    if has_unsafe_url_codepoint(resolved_base):
        raise ValueError(
            "Invalid auth.base URL: must not contain control characters or invalid Unicode"
        )

    parsed = urllib.parse.urlsplit(resolved_base)
    if parsed.scheme.lower() != _VALID_AUTH_BASE_SCHEME:
        raise ValueError("Invalid auth.base URL: scheme must be https")
    if not parsed.netloc:
        raise ValueError("Invalid auth.base URL: missing host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Invalid auth.base URL: userinfo is not allowed")
    if parsed.fragment:
        raise ValueError("Invalid auth.base URL: must not contain fragment")
    if has_unsafe_path(parsed.path):
        raise ValueError("Invalid auth.base URL: unsafe path syntax is not allowed")

    host = parsed.hostname
    if not host:
        raise ValueError("Invalid auth.base URL: missing host")
    decoded_host = _percent_decode_host(host)
    try:
        normalized_host = _normalize_hostname(decoded_host)
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
    ``resolved_query`` > resolved base query > original request query. Unsafe
    path syntax in ``rel_path`` is rejected as an invariant; firewall matching
    should already have blocked it before auth is applied.
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
