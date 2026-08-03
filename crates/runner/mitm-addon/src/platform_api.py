"""Shared platform API request and redirect-policy helpers for the mitmproxy addon."""

import os
import urllib.parse
import urllib.request
import uuid

from mitmproxy import ctx

# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
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


def get_api_url() -> str:
    """Get API URL from mitmproxy options."""
    return ctx.options.vm0_api_url


def make_api_request(url: str, data: bytes, sandbox_token: str) -> urllib.request.Request:
    """Build a Request with standard platform API headers.

    Centralises User-Agent, Authorization, Content-Type, and the optional
    Vercel bypass header so that callers cannot accidentally omit them. The
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
        req.add_unredirected_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    return req
