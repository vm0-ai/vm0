"""URL reconstruction and rewriting utilities.

Pure functions with no module-level state or I/O.
"""

import ipaddress
import urllib.parse
from dataclasses import dataclass

from mitmproxy import http
from mitmproxy.net.http import url as mitm_url

# Well-known IANA ports for HTTP and HTTPS.  When the connection uses the
# default port for its scheme we omit ``:port`` from the reconstructed URL.
_HTTP_DEFAULT_PORT = 80
_HTTPS_DEFAULT_PORT = 443
_IPV6_VERSION = 6


@dataclass(frozen=True)
class TrustedAuthority:
    host: str
    port: int
    url: str


class AuthorityValidationError(Exception):
    def __init__(
        self,
        reason: str,
        *,
        message: str,
        sni: str | None,
        request_host: str,
        host_header: str | None,
        request_port: int,
        fallback_url: str,
    ) -> None:
        super().__init__(message)
        self.reason = reason
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


def build_rewrite_url(resolved_base: str, match_info: dict, orig_query: str) -> str:
    """Build the final URL for auth.base URL rewriting.

    Combines the resolved base URL (with credentials in path), the relative
    path from the firewall match, and query strings from both base and
    original request. ``orig_query`` is the raw query string of the
    incoming request (no leading ``?``).
    """
    base_parsed = urllib.parse.urlparse(resolved_base)

    # Append rel_path to the base path portion
    rel_path = match_info.get("rel_path", "/")
    base_path = base_parsed.path.rstrip("/") + rel_path if rel_path != "/" else base_parsed.path

    # Merge query strings: base qs + original request qs
    qs_parts: list[str] = []
    if base_parsed.query:
        qs_parts.append(base_parsed.query)
    if orig_query:
        qs_parts.append(orig_query)
    merged_qs = "&".join(qs_parts)

    return urllib.parse.urlunparse(
        (base_parsed.scheme, base_parsed.netloc, base_path, "", merged_qs, "")
    )
