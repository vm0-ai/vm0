"""Integration tests for shared platform API request construction."""

import uuid
from unittest.mock import patch

import pytest

import platform_api


class TestMakeApiRequest:
    def test_builds_platform_api_request_with_standard_headers(self, mitm_ctx):
        with (
            mitm_ctx(
                client_session_id="runner-session-direct",
                client_version="runner-version-direct",
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            req = platform_api.make_api_request(
                "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
                b"{}",
                "tok-xyz",
            )

        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/firewall/auth"
        assert req.data == b"{}"
        headers = dict(req.header_items())
        assert headers["Content-type"] == "application/json"
        assert headers["Authorization"] == "Bearer tok-xyz"
        assert headers["User-agent"] == "vm0-mitm-addon/1.0"
        normalized_headers = {name.lower(): value for name, value in headers.items()}
        assert normalized_headers["x-client-version"] == "runner-version-direct"
        assert normalized_headers["x-client-type"] == "MitmAddon"
        assert normalized_headers["x-client-session-id"] == "runner-session-direct"
        uuid.UUID(normalized_headers["x-client-request-id"])

    def test_marks_credentials_as_unredirected(self, mitm_ctx):
        with (
            mitm_ctx(),
            patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
            patch.object(
                platform_api,
                "CLOUDFLARE_ACCESS_CLIENT_ID",
                "access-client-id",
            ),
            patch.object(
                platform_api,
                "CLOUDFLARE_ACCESS_CLIENT_SECRET",
                "access-client-secret",
            ),
        ):
            req = platform_api.make_api_request(
                "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
                b"{}",
                "tok-xyz",
            )

        redirected_headers = {name.lower(): value for name, value in req.headers.items()}
        unredirected_headers = {
            name.lower(): value for name, value in req.unredirected_hdrs.items()
        }
        assert "authorization" not in redirected_headers
        assert "x-vercel-protection-bypass" not in redirected_headers
        assert "cf-access-client-id" not in redirected_headers
        assert "cf-access-client-secret" not in redirected_headers
        assert unredirected_headers["authorization"] == "Bearer tok-xyz"
        assert unredirected_headers["x-vercel-protection-bypass"] == "secret-bypass-value"
        assert unredirected_headers["cf-access-client-id"] == "access-client-id"
        assert unredirected_headers["cf-access-client-secret"] == "access-client-secret"

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param("file:///etc/passwd", id="file"),
            pytest.param("ftp://example.com/api", id="ftp"),
            pytest.param(
                "//api.vm0.ai/api/webhooks/agent/firewall/auth",
                id="scheme-relative",
            ),
            pytest.param("https:path-without-host", id="https-without-host"),
        ],
    )
    def test_rejects_non_absolute_http_urls(self, url: str):
        with pytest.raises(ValueError, match="absolute http"):
            platform_api.make_api_request(url, b"{}", "tok-xyz")
