"""Integration tests for the firewall auth client and response protocol."""

import io
import json
import time
import urllib.error
import uuid
from email.message import Message
from unittest.mock import MagicMock, patch

import pytest

import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import platform_api
from aws_sigv4 import AwsSigV4Credentials
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import auth_cache_key, cached_headers, require_cached_headers
from tests.firewall_auth_helpers import firewall_auth_request

_MALFORMED_SUCCESS_PREFIX = "Firewall auth endpoint returned malformed success response"


def _http_error(url: str, status: int, reason: str, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, status, reason, Message(), io.BytesIO(body))


def _raw_response(body: bytes) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.read.return_value = body
    return mock_resp


class _UnreadableHttpErrorBody(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        raise OSError("body read failed")


class TestFetchFirewallHeaders:
    async def test_sends_request_and_maps_basic_success(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({"Authorization": "Bearer tok"})
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
                ),
            )

        assert result.payload.headers == {"Authorization": "Bearer tok"}
        assert result.payload.base is None
        assert result.payload.query is None

        assert endpoint.request_count == 1
        request = endpoint.requests[0]
        assert request.method == "POST"
        assert request.path == "/api/webhooks/agent/firewall/auth"
        assert request.headers["authorization"] == "Bearer tok-xyz"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["user-agent"] == "vm0-mitm-addon/1.0"
        assert request.headers["x-client-version"] == "runner-version-test"
        assert request.headers["x-client-type"] == "MitmAddon"
        assert request.headers["x-client-session-id"] == "runner-session-test"
        uuid.UUID(request.headers["x-client-request-id"])
        assert "x-vercel-protection-bypass" not in request.headers
        assert request.json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
        }

    async def test_success_response_shape_is_mapped(self, mitm_ctx):
        expires_at = time.time() + 30
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {
                    "Authorization": "Bearer tok",
                    "X-Custom": "custom",
                },
                expires_at=expires_at,
                resolved_secrets=["API_TOKEN"],
                refreshed_connectors=["notion"],
                refreshed_secrets=["NOTION_TOKEN"],
            )
            | {
                "base": "https://example.com/webhook/secret",
                "query": {"api_key": "resolved-key"},
                "futureField": {"ignored": True},
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_headers={
                        "Authorization": "Bearer ${{ secrets.TOKEN }}",
                        "X-Custom": "${{ secrets.CUSTOM }}",
                    },
                    auth_base="${{ secrets.WEBHOOK_URL }}",
                    auth_query={"api_key": "${{ secrets.API_KEY }}"},
                )
            )

        assert result.payload.headers == {
            "Authorization": "Bearer tok",
            "X-Custom": "custom",
        }
        assert result.payload.base == "https://example.com/webhook/secret"
        assert result.payload.query == {"api_key": "resolved-key"}
        assert result.payload.aws_sigv4 is None
        assert result.expires_at == expires_at
        assert result.payload.resolved_secrets == ["API_TOKEN"]
        assert result.refreshed_connectors == ["notion"]
        assert result.refreshed_secrets == ["NOTION_TOKEN"]
        assert not hasattr(result, "futureField")

    @pytest.mark.parametrize(
        "session_token",
        [
            pytest.param(None, id="without-session-token"),
            pytest.param("session-token", id="with-session-token"),
        ],
    )
    async def test_sigv4_success_response_is_cached(
        self,
        mitm_ctx,
        session_token: str | None,
    ):
        request_aws_sigv4 = {
            "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
            "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        }
        response_aws_sigv4: dict[str, object] = {
            "accessKeyId": "access-key-id",
            "secretAccessKey": "secret-access-key",
            "futureField": {"ignored": True},
        }
        if session_token is not None:
            request_aws_sigv4["sessionToken"] = "${{ secrets.AWS_SESSION_TOKEN }}"
            response_aws_sigv4["sessionToken"] = session_token

        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({})
            | {
                "awsSigv4": response_aws_sigv4,
            }
        )
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(auth_aws_sigv4=request_aws_sigv4),
            )

        expected_credentials = AwsSigV4Credentials(
            "access-key-id",
            "secret-access-key",
            session_token,
        )
        assert result["aws_sigv4"] == expected_credentials
        assert require_cached_headers(cache_key).aws_sigv4 == expected_credentials

    @pytest.mark.parametrize(
        ("aws_sigv4", "expected_reason"),
        [
            pytest.param(None, "awsSigv4 must be an object", id="sigv4-null"),
            pytest.param([], "awsSigv4 must be an object", id="sigv4-array"),
            pytest.param(
                {"secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-missing",
            ),
            pytest.param(
                {"accessKeyId": "", "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-empty",
            ),
            pytest.param(
                {"accessKeyId": None, "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-null",
            ),
            pytest.param(
                {"accessKeyId": 123, "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-number",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id"},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-missing",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": ""},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-empty",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": None},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-null",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": 123},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-number",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": "",
                },
                "sessionToken must not be empty",
                id="session-token-empty",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": None,
                },
                "sessionToken must be a string",
                id="session-token-null",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": 123,
                },
                "sessionToken must be a string",
                id="session-token-number",
            ),
        ],
    )
    async def test_malformed_sigv4_response_is_not_cached(
        self,
        mitm_ctx,
        aws_sigv4: object,
        expected_reason: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}) | {"awsSigv4": aws_sigv4})
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX) as exc_info,
        ):
            await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
            )

        assert str(exc_info.value) == f"{_MALFORMED_SUCCESS_PREFIX}: {expected_reason}"
        assert cached_headers(cache_key) is None

    @pytest.mark.parametrize(
        ("auth_request", "response"),
        [
            (
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
                firewall_auth_success_response({}),
            ),
            (
                firewall_auth_request(),
                firewall_auth_success_response({}) | {"base": "https://hooks.example.com/secret"},
            ),
            (
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
                firewall_auth_success_response({}) | {"base": ""},
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
                firewall_auth_success_response({}),
            ),
            (
                firewall_auth_request(),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                    },
                },
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                        "sessionToken": "session-token",
                    },
                },
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                ),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                    },
                },
            ),
            (
                firewall_auth_request(auth_headers={"Authorization": "template"}),
                firewall_auth_success_response({"X-Unexpected": "value"}),
            ),
            (
                firewall_auth_request(auth_query={"api_key": "template"}),
                firewall_auth_success_response({}) | {"query": {"unexpected": "value"}},
            ),
        ],
        ids=[
            "missing-base",
            "unexpected-base",
            "empty-base",
            "missing-sigv4",
            "unexpected-sigv4",
            "unexpected-session-token",
            "missing-session-token",
            "header-name-mismatch",
            "query-name-mismatch",
        ],
    )
    async def test_rejects_response_inconsistent_with_request(
        self,
        mitm_ctx,
        auth_request: auth_client.FirewallAuthRequest,
        response: dict[str, object],
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(response)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX),
        ):
            await auth_client.fetch_firewall_headers(auth_request)

    async def test_inconsistent_response_is_not_cached(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX),
        ):
            await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
            )

        assert cached_headers(cache_key) is None

    async def test_sends_optional_request_body_fields(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({}, expires_at=time.time() + 30)
            | {
                "base": "https://hooks.example.com/secret",
                "query": {"api_key": "resolved-key"},
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    secret_connector_map={"TOKEN": "notion"},
                    secret_connector_metadata_map={"TOKEN": {"kind": "oauth"}},
                    vars_map={"TEAM": "vm0"},
                    auth_base="${{ secrets.WEBHOOK_URL }}",
                    auth_query={"api_key": "${{ secrets.API_KEY }}"},
                    firewall_billable=True,
                ),
                force_refresh=True,
            )

        body = endpoint.requests[0].json_body()
        assert body["encryptedSecrets"] == "iv:tag:data"
        assert body["authHeaders"] == {}
        assert body["secretConnectorMap"] == {"TOKEN": "notion"}
        assert body["secretConnectorMetadataMap"] == {"TOKEN": {"kind": "oauth"}}
        assert body["vars"] == {"TEAM": "vm0"}
        assert body["authBase"] == "${{ secrets.WEBHOOK_URL }}"
        assert body["authQuery"] == {"api_key": "${{ secrets.API_KEY }}"}
        assert "authAwsSigv4" not in body
        assert body["firewallBillable"] is True
        assert body["forceRefresh"] is True
        assert "firewallName" not in body
        assert "modelUsageProvider" not in body

    async def test_sends_sigv4_request_body(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({})
            | {
                "awsSigv4": {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": "session-token",
                },
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                ),
            )

        assert endpoint.requests[0].json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {},
            "authAwsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
            },
        }

    async def test_omits_empty_optional_request_body_fields(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_query={},
                    secret_connector_map={},
                    secret_connector_metadata_map={},
                    vars_map={},
                    firewall_billable=False,
                ),
                force_refresh=False,
            )

        assert endpoint.requests[0].json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {},
        }

    def test_request_repr_omits_sensitive_values(self):
        request = firewall_auth_request(
            encrypted_secrets="secret-encrypted-payload",
            sandbox_auth="secret-sandbox-token",
        )

        rendered = repr(request)

        assert "secret-encrypted-payload" not in rendered
        assert "secret-sandbox-token" not in rendered

    async def test_includes_vercel_bypass_header(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))
        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert endpoint.requests[0].headers["x-vercel-protection-bypass"] == "secret-bypass-value"

    @pytest.mark.parametrize("status", [301, 302, 303])
    async def test_rejects_cross_origin_redirect_without_forwarding_credentials(
        self,
        status: int,
        mitm_ctx,
    ):
        source = FakeAuthEndpoint()
        target = FakeAuthEndpoint()

        with target.run():
            source.queue_response(
                status,
                headers=(("Location", f"{target.api_url}/redirected"),),
            )
            with (
                source.run(),
                mitm_ctx(api_url=source.api_url),
                patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
                pytest.raises(urllib.error.HTTPError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == status
        assert source.request_count == 1
        request = source.requests[0]
        assert request.method == "POST"
        assert request.headers["authorization"] == "Bearer tok-xyz"
        assert request.headers["x-vercel-protection-bypass"] == "secret-bypass-value"
        assert target.requests == ()

    async def test_invalid_api_url_raises_before_open(self):
        with (
            patch.object(platform_api, "get_api_url", return_value="file:///etc/passwd"),
            patch("firewall_auth_client._opener.open") as mock_open,
            pytest.raises(ValueError, match="absolute http"),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        mock_open.assert_not_called()

    async def test_424_connector_not_configured_raises_custom_error(self, mitm_ctx):
        """Auth endpoint 424 CONNECTOR_NOT_CONFIGURED raises ConnectorNotConfiguredError."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Connector not configured",
                    "code": "CONNECTOR_NOT_CONFIGURED",
                }
            },
            status=424,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth_client.ConnectorNotConfiguredError) as exc_info:
                await auth_client.fetch_firewall_headers(firewall_auth_request())
            assert "Connector not configured" in str(exc_info.value)

    async def test_402_insufficient_credits_raises_custom_error(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Insufficient credits",
                    "code": "INSUFFICIENT_CREDITS",
                }
            },
            status=402,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth_client.InsufficientCreditsError) as exc_info:
                await auth_client.fetch_firewall_headers(firewall_auth_request())
            assert "Insufficient credits" in str(exc_info.value)

    @pytest.mark.parametrize(
        (
            "status",
            "code",
            "message",
            "connectors",
            "failure_reason",
            "expected_failure_reason",
        ),
        [
            (
                424,
                "TOKEN_ACCESS_RESOLUTION_FAILED",
                "Token access resolution failed for: notion.",
                ["notion"],
                None,
                None,
            ),
            (
                403,
                "FORBIDDEN",
                "Invalid model-provider secret owner",
                None,
                None,
                None,
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: codex-oauth-token.",
                ["codex-oauth-token"],
                "upstream_provider",
                "upstream_provider",
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: notion.",
                ["notion"],
                "provider_rate_limited",
                None,
            ),
        ],
        ids=[
            "token-access-resolution",
            "forbidden",
            "token-refresh",
            "unknown-failure-reason",
        ],
    )
    async def test_current_structured_error_raises_custom_error(
        self,
        mitm_ctx,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None,
        failure_reason: str | None,
        expected_failure_reason: str | None,
    ):
        """Current auth endpoint errors should preserve their code and connectors."""
        error_info: dict[str, object] = {
            "message": message,
            "code": code,
        }
        if connectors is not None:
            error_info["connectors"] = connectors
        if failure_reason is not None:
            error_info["failureReason"] = failure_reason
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"error": error_info}, status=status)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(auth_client.FirewallAuthApiError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.status == status
        assert exc_info.value.code == code
        assert str(exc_info.value) == message
        assert exc_info.value.connectors == connectors
        assert exc_info.value.failure_reason == expected_failure_reason

    async def test_structured_http_error_at_body_limit_is_preserved(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body),
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(auth_client.FirewallAuthApiError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == "TOKEN_REFRESH_FAILED"

    async def test_http_error_over_body_limit_raises(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body) - 1,
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(
                auth_client.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

    @pytest.mark.parametrize(
        "error_body",
        [
            pytest.param(b"\xff", id="invalid-utf8"),
            b"not-json",
            b'"plain string"',
            b"[1, 2, 3]",
            b"{}",
            json.dumps({"error": "not-a-dict"}).encode(),
            json.dumps({"error": None}).encode(),
            json.dumps({"error": {}}).encode(),
            json.dumps({"error": {"message": "Bad Request", "code": "BAD_REQUEST"}}).encode(),
        ],
    )
    async def test_malformed_http_error_envelope_reraises_http_error(
        self,
        mitm_ctx,
        error_body: bytes,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(400, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == 400

    @pytest.mark.parametrize(
        ("code", "status", "exception_type", "default_message"),
        [
            (
                "CONNECTOR_NOT_CONFIGURED",
                424,
                auth_client.ConnectorNotConfiguredError,
                "Connector not configured",
            ),
            (
                "INSUFFICIENT_CREDITS",
                402,
                auth_client.InsufficientCreditsError,
                "Insufficient credits",
            ),
        ],
    )
    async def test_known_error_with_non_string_message_uses_default(
        self,
        mitm_ctx,
        code: str,
        status: int,
        exception_type: type[Exception],
        default_message: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": None,
                    "code": code,
                }
            },
            status=status,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(exception_type) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert str(exc_info.value) == default_message

    async def test_async_wrapper_uses_api_url_from_ctx(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({"Auth": "tok"}))

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    encrypted_secrets="enc",
                    auth_headers={"Auth": "${{ secrets.TOKEN }}"},
                    sandbox_auth="sandbox-tok",
                )
            )

        assert result.payload.headers == {"Auth": "tok"}
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"


class TestFirewallAuthSuccessParser:
    @pytest.mark.parametrize(
        "body",
        [
            pytest.param([], id="array"),
            pytest.param(None, id="null"),
            pytest.param("plain string", id="string"),
            pytest.param(123, id="number"),
            pytest.param(
                {
                    "expiresAt": None,
                    "resolvedSecrets": [],
                    "refreshedConnectors": [],
                    "refreshedSecrets": [],
                },
                id="missing-headers",
            ),
            pytest.param(firewall_auth_success_response({}) | {"headers": []}, id="headers-array"),
            pytest.param(
                firewall_auth_success_response({}) | {"headers": {"Authorization": 123}},
                id="header-value-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"base": []},
                id="base-array",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"base": ""},
                id="base-empty",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"query": []},
                id="query-array",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"query": {"api_key": 123}},
                id="query-value-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"resolvedSecrets": "TOKEN"},
                id="resolved-secrets-string",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"refreshedConnectors": [123]},
                id="refreshed-connectors-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"refreshedSecrets": [None]},
                id="refreshed-secrets-null",
            ),
        ],
    )
    def test_malformed_success_response_shape_raises_value_error(self, body: object):
        with pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX):
            auth_client._parse_firewall_auth_success(body, firewall_auth_request())


class TestFirewallAuthResponseBodyReader:
    def test_response_at_body_limit_is_accepted(self):
        response_body = json.dumps({"headers": {}}).encode()
        mock_resp = _raw_response(response_body)

        with patch.object(auth_client, "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES", len(response_body)):
            assert auth_client._read_firewall_auth_response_body(mock_resp) == response_body

        mock_resp.read.assert_called_once_with(len(response_body) + 1)

    def test_response_over_body_limit_raises(self):
        response_body = json.dumps({"headers": {}}).encode()
        mock_resp = _raw_response(response_body)

        with (
            patch.object(
                auth_client, "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES", len(response_body) - 1
            ),
            pytest.raises(
                auth_client.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            auth_client._read_firewall_auth_response_body(mock_resp)

        mock_resp.read.assert_called_once_with(len(response_body))


class TestFetchFirewallHeadersResourceBoundary:
    def test_closes_response_on_success(self, mitm_ctx):
        """Success path must close the HTTP response — FD leak guard (#10475)."""
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(firewall_auth_success_response({})).encode()

        with (
            mitm_ctx(),
            patch("platform_api.urllib.request.Request"),
            patch("firewall_auth_client._opener.open", return_value=mock_resp),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            auth_client._fetch_firewall_headers_sync(firewall_auth_request(), "https://api.vm0.ai")

        mock_resp.__exit__.assert_called_once()  # urllib external boundary (#9991)

    def test_closes_http_error_response_when_body_is_unreadable(self, mitm_ctx):
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            Message(),
            _UnreadableHttpErrorBody(),
        )
        http_error.close = MagicMock()

        with (
            mitm_ctx(),
            patch("platform_api.urllib.request.Request"),
            patch("firewall_auth_client._opener.open", side_effect=http_error),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            auth_client._fetch_firewall_headers_sync(firewall_auth_request(), "https://api.vm0.ai")

        assert exc_info.value is http_error
        http_error.close.assert_called_once()

    def test_closes_http_error_response_when_body_has_invalid_utf8(self, mitm_ctx):
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            b"\xff",
        )
        http_error.close = MagicMock()

        with (
            mitm_ctx(),
            patch("platform_api.urllib.request.Request"),
            patch("firewall_auth_client._opener.open", side_effect=http_error),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            auth_client._fetch_firewall_headers_sync(firewall_auth_request(), "https://api.vm0.ai")

        assert exc_info.value is http_error
        assert exc_info.value.code == 400
        http_error.close.assert_called_once()

    def test_closes_http_error_response_when_body_is_too_large(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            502,
            "Bad Gateway",
            error_body,
        )
        http_error.close = MagicMock()

        with (
            mitm_ctx(),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body) - 1,
            ),
            patch("platform_api.urllib.request.Request"),
            patch("firewall_auth_client._opener.open", side_effect=http_error),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(
                auth_client.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            auth_client._fetch_firewall_headers_sync(firewall_auth_request(), "https://api.vm0.ai")

        http_error.close.assert_called_once()

    @pytest.mark.parametrize(
        ("error_body", "expected_exception"),
        [
            (
                json.dumps(
                    {
                        "error": {
                            "message": "Access token expired and refresh failed for: notion.",
                            "code": "TOKEN_REFRESH_FAILED",
                        }
                    }
                ).encode(),
                auth_client.FirewallAuthApiError,
            ),
            (b"{}", urllib.error.HTTPError),
        ],
    )
    def test_closes_http_error_response(
        self,
        mitm_ctx,
        error_body: bytes,
        expected_exception: type[Exception],
    ):
        """HTTPError path must close the underlying socket — FD leak guard (#10475)."""
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            error_body,
        )
        http_error.close = MagicMock()

        with (
            mitm_ctx(),
            patch("platform_api.urllib.request.Request"),
            patch("firewall_auth_client._opener.open", side_effect=http_error),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(expected_exception),
        ):
            auth_client._fetch_firewall_headers_sync(firewall_auth_request(), "https://api.vm0.ai")

        http_error.close.assert_called_once()  # urllib external boundary (#9991)
