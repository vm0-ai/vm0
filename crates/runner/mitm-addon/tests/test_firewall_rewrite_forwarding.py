"""auth.base rewrite forwarding handler tests."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import auth
import auth_base_forwarder as forwarder
from tests.firewall_rewrite_helpers import make_forwarding_rewrite_inputs


class TestAuthBaseUrlRewriteForwarding:
    """auth.base rewrite forwarding handler tests."""

    async def test_forward_request_includes_auth_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.headers are forwarded without mutating the placeholder request."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
        )
        token_meta["headers"] = {
            "Authorization": "Bearer real-token",
            "X-Custom": "injected-value",
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Auth headers passed to forward_request.
        call_args = mock_forward.call_args
        req_headers = call_args[0][2]
        assert ("Authorization", "Bearer agent") not in req_headers
        assert ("Authorization", "Bearer real-token") in req_headers
        assert ("X-Custom", "injected-value") in req_headers
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers

    async def test_forward_request_preserves_duplicate_headers_and_auth_override(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.base forwarding keeps repeated headers unless auth overrides that name."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Connection", "Authorization, X-Remove"),
                ("X-Remove", "drop"),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("Authorization", "Bearer agent"),
                ("authorization", "Bearer lower-agent"),
                ("AUTHORIZATION", "Bearer upper-agent"),
                ("Authorization", "Bearer stale"),
            ),
        )
        token_meta["headers"] = {"Authorization": "Bearer real"}
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        req_headers = mock_forward.call_args[0][2]
        assert ("Connection", "Authorization, X-Remove") not in req_headers
        assert ("X-Remove", "drop") not in req_headers
        assert req_headers.count(("X-Repeat", "one")) == 1
        assert req_headers.count(("X-Repeat", "two")) == 1
        assert ("Authorization", "Bearer agent") not in req_headers
        assert ("authorization", "Bearer lower-agent") not in req_headers
        assert ("AUTHORIZATION", "Bearer upper-agent") not in req_headers
        assert ("Authorization", "Bearer stale") not in req_headers
        assert req_headers.count(("Authorization", "Bearer real")) == 1

    async def test_forward_request_filters_client_and_injected_unsafe_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Unsafe client and injected headers are stripped without suppressing auth."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Connection", "Authorization"),
                ("Host", "evil-client.example.com"),
                ("Content-Length", "123"),
                ("Transfer-Encoding", "chunked"),
                ("Keep-Alive", "timeout=5"),
                ("Proxy-Authenticate", "Basic realm=client"),
                ("Proxy-Authorization", "Basic client"),
                ("Proxy-Connection", "keep-alive"),
                ("TE", "trailers"),
                ("Trailer", "X-Client-Trailer"),
                ("Upgrade", "websocket"),
                ("Authorization", "Bearer agent"),
                ("X-Keep", "client"),
            ),
        )
        token_meta["headers"] = {
            "Connection": "Authorization, X-Injected",
            "Keep-Alive": "timeout=5",
            "Host": "evil.example.com",
            "Content-Length": "999",
            "Transfer-Encoding": "chunked",
            "Proxy-Authenticate": "Basic realm=proxy",
            "Proxy-Authorization": "Basic secret",
            "Proxy-Connection": "keep-alive",
            "TE": "trailers",
            "Trailer": "X-Trailer",
            "Upgrade": "websocket",
            "Authorization": "Bearer real",
            "X-Injected": "trusted",
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        req_headers = mock_forward.call_args[0][2]
        header_names = [name.lower() for name, _value in req_headers]
        blocked_headers = {
            "connection",
            "content-length",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
        }
        assert blocked_headers.isdisjoint(header_names)
        assert ("Authorization", "Bearer agent") not in req_headers
        assert ("Authorization", "Bearer real") in req_headers
        assert ("X-Injected", "trusted") in req_headers
        assert ("X-Keep", "client") in req_headers

    async def test_forward_request_uses_raw_body_for_any_method(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """auth.base forwarding does not drop bodies for non-POST methods."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="DELETE",
            request_body=b"delete-body",
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_args[0][1] == "DELETE"
        assert mock_forward.call_args[0][3] == b"delete-body"

    async def test_forward_request_preserves_empty_raw_body(self, real_flow, mitm_ctx, tmp_path):
        """An explicit empty body is distinct from no body for Content-Length."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"",
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_args[0][3] == b""

    async def test_forward_request_preserves_absent_body(self, real_flow, mitm_ctx, tmp_path):
        """A request with no raw body remains distinct from an explicit empty body."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="GET",
            request_body=None,
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_args[0][3] is None

    async def test_forward_request_accepts_body_at_limit(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"1234",
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert get_headers.await_count == 1
        assert mock_forward.call_args[0][3] == b"1234"
        assert flow.response is not None
        assert flow.response.status_code == 200

    async def test_oversized_request_body_returns_413_before_auth_resolution(
        self, real_flow, mitm_ctx, tmp_path
    ):
        request_body = b"super-secret-body"
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=request_body,
            token_overrides={
                "base": "https://real.example.com/webhook/super-secret-token",
                "headers": {"Authorization": "Bearer real-token"},
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        get_headers.assert_not_called()
        mock_forward.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 413
        body = json.loads(flow.response.content)
        assert body == {
            "error": "auth_base_request_body_too_large",
            "message": "auth.base request body too large",
            "permission": allow.name,
            "base": allow.api_entry["base"],
        }
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_base_request_body_too_large"
        assert "auth_url_rewrite" not in flow.metadata
        assert "auth_resolved_secrets" not in flow.metadata
        response_text = flow.response.text
        assert "super-secret-body" not in response_text
        assert "super-secret-token" not in response_text
        assert "Bearer real-token" not in response_text
        assert "iv:tag:data" not in response_text
        assert mock_log.call_args is not None
        _args, kwargs = mock_log.call_args
        assert kwargs["firewall_base"] == allow.api_entry["base"]
        assert kwargs["request_body_size_bytes"] == len(request_body)
        assert kwargs["request_body_limit_bytes"] == 4
        for log_call in mock_log.call_args_list:
            assert "super-secret-body" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "Bearer real-token" not in json.dumps(log_call.args)
            assert "iv:tag:data" not in json.dumps(log_call.args)
            assert "super-secret-body" not in json.dumps(log_call.kwargs)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)
            assert "Bearer real-token" not in json.dumps(log_call.kwargs)
            assert "iv:tag:data" not in json.dumps(log_call.kwargs)

    async def test_forward_request_too_large_error_returns_413(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"1234",
            resolved_base="https://real.example.com/webhook/super-secret-token",
            token_overrides={"headers": {"Authorization": "Bearer real-token"}},
        )
        mock_forward = AsyncMock(side_effect=forwarder.ForwardedRequestTooLargeError())
        mock_log = MagicMock()
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 100),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert mock_forward.call_count == 1
        assert flow.response is not None
        assert flow.response.status_code == 413
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_base_request_body_too_large"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_base_request_body_too_large"
        assert "auth_url_rewrite" not in flow.metadata
        assert "url_rewrite_forward_failed" not in flow.response.text
        assert "super-secret-token" not in flow.response.text
        assert "Bearer real-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "Bearer real-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)
            assert "Bearer real-token" not in json.dumps(log_call.kwargs)

    async def test_non_auth_base_rule_does_not_use_auth_base_body_cap(
        self, real_flow, mitm_ctx, tmp_path
    ):
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"12345",
            auth_overrides={
                "base": None,
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
            },
            token_overrides={
                "base": None,
                "headers": {"Authorization": "Bearer real-token"},
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert get_headers.await_count == 1
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert "firewall_error" not in flow.metadata
        assert "auth_url_rewrite" not in flow.metadata

    async def test_forward_failure_returns_502(self, headers, real_flow, mitm_ctx, tmp_path):
        """forward_request exception produces a 502 error response and marks
        firewall_error without falling through to the success-path metadata.

        Regression for #10341: the except block previously lacked a ``return``,
        so ``auth_url_rewrite`` and a misleading ``Firewall URL rewrite`` info
        log were emitted on failure, and ``firewall_error`` was left unset —
        making failed rewrites indistinguishable from successful ones in
        dashboards."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["WEBHOOK"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)
        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        failed_url = mock_forward.call_args[0][0]
        failed_query = parse_qs(urlparse(failed_url).query, keep_blank_values=True)
        failed_headers = mock_forward.call_args[0][2]
        assert failed_query["api_key"] == ["resolved-key"]
        assert failed_query["client"] == ["visible"]
        assert ("Authorization", "Bearer agent") not in failed_headers
        assert ("Authorization", "Bearer real-token") in failed_headers
        assert ("X-Custom", "injected-value") in failed_headers
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.response.headers["Content-Type"] == "application/json"
        body = json.loads(flow.response.content)
        assert body["error"] == "url_rewrite_forward_failed"
        assert body["message"] == "Failed to forward request to upstream"
        assert body["permission"] == allow.name
        assert body["base"] == allow.api_entry["base"]
        assert "connectors" not in body
        # Failure must not masquerade as a successful rewrite.
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        assert "auth_resolved_secrets" not in flow.metadata
        assert "auth_refreshed_connectors" not in flow.metadata
        assert "auth_refreshed_secrets" not in flow.metadata
        assert "auth_cache_hit" not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        # Success-path log line must not be written.
        log_text = await asyncio.to_thread(
            lambda: proxy_log_path.read_text() if proxy_log_path.exists() else ""
        )
        assert "URL rewrite forward failed" in log_text
        assert "Firewall URL rewrite:" not in log_text
        assert f"Firewall {allow.api_entry['base']}:" not in log_text
