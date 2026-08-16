"""Trusted request authority validation and URL reconstruction.

Pure functions with no module-level state or I/O.

Host/SNI input is a distinct trust boundary from auth.base targets. This
module rejects percent-encoded authority syntax before using request authority
for firewall matching or credential injection.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http

from authority_utils import (
    IPV6_VERSION,
    format_url_host,
    has_ascii_space_or_control,
    is_default_scheme_port,
    parse_authority_port,
)
from host_normalization import normalize_hostname

_FORBIDDEN_HOST_CHARS = frozenset("#%*,/<>?@[\\]^|{}")
_DEFAULT_HTTPS_PORT = 443


@dataclass(frozen=True)
class TrustedAuthority:
    """Authority components trusted by firewall/auth decisions.

    For HTTPS, ``host`` is the normalized TLS SNI after HTTP request authority
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
    - ``invalid_authority``: an asserted HTTP authority was ambiguous or failed
      parsing or normalization.
    - ``authority_mismatch``: an asserted authority hostname did not match TLS
      SNI.
    - ``authority_port_mismatch``: an asserted authority port did not match the
      destination port.
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


def _host_with_port(scheme: str, host: str, port: int) -> str:
    url_host = format_url_host(host)
    if scheme in ("http", "https") and not is_default_scheme_port(scheme, port):
        return f"{url_host}:{port}"
    return url_host


def _build_url(scheme: str, host: str, port: int, path: str) -> str:
    uri_path = "" if path == "*" else path
    return f"{scheme}://{_host_with_port(scheme, host, port)}{uri_path}"


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
    upstream TLS, while Host, HTTP/1 request-target authority, and HTTP/2/3
    ``:authority`` values are only client assertions. Require every HTTP
    authority to agree with SNI before using the URL for firewall matching or
    credential injection. For non-HTTPS traffic there is no SNI binding, so use
    the transparent destination host and do not trust Host.

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

    raw_host_headers = flow.request.headers.get_all("Host")
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
        normalized_sni = normalize_hostname(sni)
    except (UnicodeError, ValueError):
        raise _authority_validation_error(
            "invalid_sni",
            message="Request blocked: HTTPS request has invalid TLS SNI",
            fallback_url=_build_url(scheme, request_host, port, path),
        ) from None

    trusted_url = _build_url(scheme, normalized_sni, port, path)
    if len(raw_host_headers) > 1:
        raise _authority_validation_error(
            "invalid_authority",
            message="Request blocked: HTTPS request has multiple Host fields",
            fallback_url=trusted_url,
        )

    if not host_header:
        raise _authority_validation_error(
            "missing_authority",
            message="Request blocked: HTTPS request is missing Host authority",
            fallback_url=trusted_url,
        )

    authority_assertions: list[tuple[str, int | None]] = [(host_header, None)]
    if flow.request.authority:
        if flow.request.is_http2 or flow.request.is_http3:
            if raw_host_headers:
                authority_assertions.append((raw_host_headers[0], None))
        else:
            # Unlike a Host field, an absolute HTTPS URI with no explicit port
            # identifies the default 443 origin.
            authority_assertions.append((flow.request.authority, _DEFAULT_HTTPS_PORT))

    for authority, implicit_port in authority_assertions:
        try:
            parsed_host, explicit_port = _parse_host_authority(authority)
            normalized_authority_host = normalize_hostname(parsed_host)
        except (UnicodeError, ValueError):
            raise _authority_validation_error(
                "invalid_authority",
                message="Request blocked: HTTPS request has invalid Host authority",
                fallback_url=trusted_url,
            ) from None

        if normalized_authority_host != normalized_sni:
            raise _authority_validation_error(
                "authority_mismatch",
                message="Request blocked: Host authority does not match TLS SNI",
                fallback_url=trusted_url,
            )

        effective_port = explicit_port if explicit_port is not None else implicit_port
        if effective_port is not None and effective_port != port:
            raise _authority_validation_error(
                "authority_port_mismatch",
                message="Request blocked: Host authority port does not match destination port",
                fallback_url=trusted_url,
            )

    return TrustedAuthority(host=normalized_sni, port=port, url=trusted_url)
