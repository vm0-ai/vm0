"""URL reconstruction and rewriting utilities.

Pure functions with no module-level state or I/O.
"""

import ipaddress
import urllib.parse
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http
from mitmproxy.net.http import url as mitm_url

# Well-known IANA ports for HTTP and HTTPS.  When the connection uses the
# default port for its scheme we omit ``:port`` from the reconstructed URL.
_HTTP_DEFAULT_PORT = 80
_HTTPS_DEFAULT_PORT = 443
_IPV6_VERSION = 6


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


def _normalize_hostname(host: str) -> str:
    normalized = host.rstrip(".").lower()
    if not normalized:
        raise ValueError("empty hostname")
    return normalized.encode("idna").decode("ascii").lower()


def _format_url_host(host: str) -> str:
    candidate = host
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if ":" not in candidate:
        return host
    try:
        parsed = ipaddress.ip_address(candidate)
    except ValueError:
        return host
    if parsed.version == _IPV6_VERSION:
        return f"[{candidate}]"
    return candidate


def _host_with_port(scheme: str, host: str, port: int) -> str:
    url_host = _format_url_host(host)
    if (scheme == "https" and port != _HTTPS_DEFAULT_PORT) or (
        scheme == "http" and port != _HTTP_DEFAULT_PORT
    ):
        return f"{url_host}:{port}"
    return url_host


def _build_url(scheme: str, host: str, port: int, path: str) -> str:
    return f"{scheme}://{_host_with_port(scheme, host, port)}{path}"


def _parse_host_authority(authority: str) -> tuple[str, int | None]:
    host, port = mitm_url.parse_authority(authority, check=True)
    return host, port


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
    if not sni:
        raise AuthorityValidationError(
            "missing_sni",
            message="Request blocked: HTTPS request is missing TLS SNI",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=_build_url(scheme, request_host, port, path),
        )

    try:
        normalized_sni = _normalize_hostname(sni)
    except (UnicodeError, ValueError):
        raise AuthorityValidationError(
            "invalid_sni",
            message="Request blocked: HTTPS request has invalid TLS SNI",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=_build_url(scheme, request_host, port, path),
        ) from None

    trusted_url = _build_url(scheme, normalized_sni, port, path)
    if not host_header:
        raise AuthorityValidationError(
            "missing_authority",
            message="Request blocked: HTTPS request is missing Host authority",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=trusted_url,
        )

    try:
        header_host, header_port = _parse_host_authority(host_header)
        normalized_header_host = _normalize_hostname(header_host)
    except (UnicodeError, ValueError):
        raise AuthorityValidationError(
            "invalid_authority",
            message="Request blocked: HTTPS request has invalid Host authority",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=trusted_url,
        ) from None

    if normalized_header_host != normalized_sni:
        raise AuthorityValidationError(
            "authority_mismatch",
            message="Request blocked: Host authority does not match TLS SNI",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=trusted_url,
        )

    if header_port is not None and header_port != port:
        raise AuthorityValidationError(
            "authority_port_mismatch",
            message="Request blocked: Host authority port does not match destination port",
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
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
    """
    base_parsed = urllib.parse.urlsplit(resolved_base)

    # Append rel_path to the base path portion
    base_path = base_parsed.path.rstrip("/") + rel_path if rel_path != "/" else base_parsed.path

    merged_qs = _merge_rewrite_query(base_parsed.query, orig_query, resolved_query)

    return urllib.parse.urlunsplit(
        (base_parsed.scheme, base_parsed.netloc, base_path, merged_qs, "")
    )
