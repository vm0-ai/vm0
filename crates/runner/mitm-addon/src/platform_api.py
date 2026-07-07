"""Shared platform API request helpers for the mitmproxy addon."""

import os
import urllib.parse
import urllib.request
import uuid

from mitmproxy import ctx

from mitm_addon_version import MITM_ADDON_VERSION

# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
PLATFORM_CLIENT_VERSION_HEADER = "X-Client-Version"
PLATFORM_CLIENT_TYPE_HEADER = "X-Client-Type"
PLATFORM_CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id"
PLATFORM_CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id"
MITM_ADDON_CLIENT_TYPE = "MitmAddon"


def get_api_url() -> str:
    """Get API URL from mitmproxy options."""
    return ctx.options.vm0_api_url


def make_api_request(url: str, data: bytes, sandbox_token: str) -> urllib.request.Request:
    """Build a Request with standard platform API headers.

    Centralises User-Agent, Authorization, Content-Type, and the optional
    Vercel bypass header so that callers cannot accidentally omit them.
    """
    parsed_url = urllib.parse.urlsplit(url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError("Platform API URL must be an absolute http(s) URL")

    # S310 (suspicious-url-open-usage): callers build `url` from the
    # operator-configured platform API URL, and the scheme is validated above
    # before urllib can consume the request.
    req = urllib.request.Request(  # noqa: S310
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {sandbox_token}",
            "User-Agent": "vm0-mitm-addon/1.0",
            PLATFORM_CLIENT_VERSION_HEADER: MITM_ADDON_VERSION,
            PLATFORM_CLIENT_TYPE_HEADER: MITM_ADDON_CLIENT_TYPE,
            PLATFORM_CLIENT_SESSION_ID_HEADER: ctx.options.vm0_client_session_id,
            PLATFORM_CLIENT_REQUEST_ID_HEADER: str(uuid.uuid4()),
        },
    )
    if VERCEL_BYPASS:
        req.add_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    return req
