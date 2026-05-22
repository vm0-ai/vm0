"""HTTP forwarding for auth.base URL rewrites.

The addon forwards auth.base requests itself because mitmproxy's eager
connection has already connected to the placeholder IP. This module owns
the low-level HTTP details for that forward path.
"""

import asyncio
import http.client as http_client
import urllib.parse

from mitmproxy import http

HOP_BY_HOP: frozenset[str] = frozenset(
    (
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    )
)
DEFAULT_HTTP_PORT = 80
DEFAULT_HTTPS_PORT = 443


def header_pairs(headers) -> list[tuple[str, str]]:
    if isinstance(headers, dict):
        return list(headers.items())
    if hasattr(headers, "items"):
        try:
            return list(headers.items(multi=True))
        except TypeError:
            return list(headers.items())
    return list(headers)


def _connection_header_names(headers: list[tuple[str, str]]) -> set[str]:
    names: set[str] = set()
    for header_name, header_value in headers:
        if header_name.lower() != "connection":
            continue
        for token in header_value.split(","):
            token = token.strip().lower()
            if token:
                names.add(token)
    return names


def _filter_header_pairs(
    headers,
    *,
    extra_excluded: set[str] | None = None,
) -> list[tuple[str, str]]:
    pairs = header_pairs(headers)
    excluded = set(HOP_BY_HOP)
    excluded.update(_connection_header_names(pairs))
    if extra_excluded:
        excluded.update(extra_excluded)
    return [(name, value) for name, value in pairs if name.lower() not in excluded]


def forwarded_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Return request headers that are safe to forward to the auth.base target."""
    return _filter_header_pairs(
        headers,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )


def trusted_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Return trusted injected request headers safe to append after client filtering."""
    excluded = set(HOP_BY_HOP)
    excluded.update({"host", "content-length", "transfer-encoding"})
    return [(name, value) for name, value in header_pairs(headers) if name.lower() not in excluded]


def _headers_from_pairs(pairs: list[tuple[str, str]]) -> http.Headers:
    return http.Headers(
        (
            name.encode("utf-8", "surrogateescape"),
            value.encode("utf-8", "surrogateescape"),
        )
        for name, value in pairs
    )


def _filter_response_headers(raw) -> http.Headers:
    """Strip hop-by-hop headers from an upstream response.

    The response body is fully read, so headers like transfer-encoding must
    not be forwarded. Headers named by Connection are hop-by-hop too.
    """
    return _headers_from_pairs(_filter_header_pairs(raw))


def _host_header(parsed: urllib.parse.SplitResult) -> str:
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid upstream URL: missing host")
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    if (
        port is None
        or (parsed.scheme == "https" and port == DEFAULT_HTTPS_PORT)
        or (parsed.scheme == "http" and port == DEFAULT_HTTP_PORT)
    ):
        return host
    return f"{host}:{port}"


def _request_target(parsed: urllib.parse.SplitResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _connection_cls(scheme: str):
    if scheme == "https":
        return http_client.HTTPSConnection
    if scheme == "http":
        return http_client.HTTPConnection
    raise ValueError(f"Unsupported URL scheme: {scheme}")


def _reject_userinfo(parsed: urllib.parse.SplitResult) -> None:
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Unsupported URL authority: userinfo is not allowed")


def _outbound_request_headers(
    headers: list[tuple[str, str]],
    parsed: urllib.parse.SplitResult,
    body: bytes | None,
) -> list[tuple[str, str]]:
    filtered = forwarded_request_header_pairs(headers)
    outbound = [("Host", _host_header(parsed)), *filtered]
    if body is not None:
        outbound.append(("Content-Length", str(len(body))))
    return outbound


def _forward_request_sync(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> tuple[int, bytes, http.Headers]:
    """Forward an HTTP request to the real URL and return (status, body, headers).

    Security: only https/http schemes are allowed, and redirects are returned
    to the sandbox client instead of being followed inside the addon.
    """
    parsed = urllib.parse.urlsplit(url)
    conn_cls = _connection_cls(parsed.scheme)
    _reject_userinfo(parsed)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid upstream URL: missing host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    conn = conn_cls(host, port=port, timeout=30)
    resp = None
    try:
        conn.putrequest(
            method,
            _request_target(parsed),
            skip_host=True,
            skip_accept_encoding=True,
        )
        for header_name, header_value in _outbound_request_headers(headers, parsed, body):
            conn.putheader(header_name, header_value)
        conn.endheaders(body)
        resp = conn.getresponse()
        resp_body = resp.read()
        return resp.status, resp_body, _filter_response_headers(resp.getheaders())
    finally:
        if resp is not None:
            resp.close()
        conn.close()


async def forward_request(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> tuple[int, bytes, http.Headers]:
    """Async wrapper for _forward_request_sync."""
    return await asyncio.to_thread(_forward_request_sync, url, method, headers, body)
