"""Shared platform API request and redirect-policy helpers for the mitmproxy addon."""

import os
import urllib.parse
import urllib.request
import uuid

from mitmproxy import ctx, http

# Preview ingress credentials remain runner-owned and are injected only after a
# request has been admitted as platform API traffic.
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
_VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass"
CLOUDFLARE_ACCESS_CLIENT_ID = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CLOUDFLARE_ACCESS_CLIENT_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
_CLOUDFLARE_ACCESS_HEADERS = ("cf-access-client-id", "cf-access-client-secret")
CLIENT_VERSION_HEADER = "X-Client-Version"
CLIENT_TYPE_HEADER = "X-Client-Type"
CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id"
CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id"
CLIENT_TYPE_MITM_ADDON = "MitmAddon"
_CLIENT_HEADERS = ("", "")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reject redirects from credential-bearing platform API requests."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def build_api_opener() -> urllib.request.OpenerDirector:
    """Build an opener that returns redirects as HTTP errors."""
    return urllib.request.build_opener(_NoRedirect)


def configure_client_headers(*, client_session_id: str, client_version: str) -> None:
    """Snapshot runner-provided client header values for platform API requests."""
    global _CLIENT_HEADERS
    _CLIENT_HEADERS = (client_session_id, client_version)


def add_vercel_bypass_header(headers: http.Headers) -> None:
    """Add the runner-owned preview bypass to an admitted platform API request."""
    if VERCEL_BYPASS:
        headers[_VERCEL_BYPASS_HEADER] = VERCEL_BYPASS


def add_cloudflare_access_headers(headers: http.Headers) -> None:
    """Add runner-owned Access credentials to admitted platform API traffic."""
    if CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET:
        headers[_CLOUDFLARE_ACCESS_HEADERS[0]] = CLOUDFLARE_ACCESS_CLIENT_ID
        headers[_CLOUDFLARE_ACCESS_HEADERS[1]] = CLOUDFLARE_ACCESS_CLIENT_SECRET


def get_api_url() -> str:
    """Get API URL from mitmproxy options."""
    return ctx.options.vm0_api_url


def make_api_request(url: str, data: bytes, sandbox_token: str) -> urllib.request.Request:
    """Build a Request with standard platform API headers.

    Centralises User-Agent, Authorization, Content-Type, and the optional
    preview ingress headers so that callers cannot accidentally omit them. The
    credentials are unredirected as defense in depth; callers must still reject
    redirects, using :func:`build_api_opener` or an equivalent transport policy,
    before contacting another URL.
    """
    parsed_url = urllib.parse.urlsplit(url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError("Platform API URL must be an absolute http(s) URL")
    client_session_id, client_version = _CLIENT_HEADERS

    # S310 (suspicious-url-open-usage): callers build `url` from the
    # operator-configured platform API URL, and the scheme is validated above
    # before urllib can consume the request.
    req = urllib.request.Request(  # noqa: S310
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "vm0-mitm-addon/1.0",
            CLIENT_VERSION_HEADER: client_version,
            CLIENT_TYPE_HEADER: CLIENT_TYPE_MITM_ADDON,
            CLIENT_SESSION_ID_HEADER: client_session_id,
            CLIENT_REQUEST_ID_HEADER: str(uuid.uuid4()),
        },
    )
    req.add_unredirected_header("Authorization", f"Bearer {sandbox_token}")
    if VERCEL_BYPASS:
        req.add_unredirected_header(_VERCEL_BYPASS_HEADER, VERCEL_BYPASS)
    if CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET:
        req.add_unredirected_header(
            _CLOUDFLARE_ACCESS_HEADERS[0],
            CLOUDFLARE_ACCESS_CLIENT_ID,
        )
        req.add_unredirected_header(
            _CLOUDFLARE_ACCESS_HEADERS[1],
            CLOUDFLARE_ACCESS_CLIENT_SECRET,
        )
    return req
