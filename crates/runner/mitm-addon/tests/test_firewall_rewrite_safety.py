"""auth.base rewrite safety and fail-closed handler tests."""

import json
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

import pytest

import auth
import auth_base_forwarder as forwarder
from tests.firewall_rewrite_helpers import make_safety_rewrite_inputs


class TestAuthBaseUrlRewriteSafety:
    """auth.base rewrite safety and fail-closed handler tests."""

    async def test_forward_failure_does_not_log_resolved_url_secret(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Forward errors must not leak secret-bearing resolved auth.base URLs."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://real.example.com/webhook/super-secret-token",
        )
        mock_forward = AsyncMock(
            side_effect=Exception("failed https://real.example.com/webhook/super-secret-token")
        )
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert b"super-secret-token" not in flow.response.content
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_blocked_forward_destination_returns_502_without_mutating_request(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Forwarder destination guard failures use the local rewrite failure path."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="https://127.0.0.1/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
            },
        )
        mock_forward = AsyncMock(
            side_effect=forwarder.UnsafeAuthBaseDestinationError(
                "Unsafe auth.base upstream destination"
            )
        )
        mock_log = MagicMock()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_count == 1
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        assert "super-secret-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_resolved_base_http_fails_closed_without_forwarding(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Secret-backed auth.base upstream URLs must not use cleartext HTTP."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="http://real.example.com/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
            },
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        assert "super-secret-token" not in flow.response.text
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_resolved_base_fragment_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Secret-backed auth.base fragments must not be silently dropped."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://real.example.com/webhook/super-secret-token#fragment",
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert "super-secret-token" not in flow.response.text
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    @pytest.mark.parametrize(
        "resolved_base",
        [
            "https://real.example.com/webhook/%5csuper-secret-token",
            "https://real.example.com/webhook/%255csuper-secret-token",
            "https://real.example.com/webhook/%zzsuper-secret-token",
            "https://real.example.com/webhook/%25zzsuper-secret-token",
            "https://real.example.com/webhook/%00super-secret-token",
            "https://real.example.com/webhook/%2500super-secret-token",
            "https://real.example.com/webhook/%7fsuper-secret-token",
            "https://real.example.com/webhook/%ef%bc%8e%ef%bc%8e/super-secret-token",
            "https://real.example.com/webhook/%ef%bc%8f../super-secret-token",
            "https://real.example.com/webhook/%ef%bc%bcsuper-secret-token",
            "https://real.example.com/webhook/%ef%bc%852esuper-secret-token",
            "https://real.example.com/webhook/%ffsuper-secret-token",
            "https://real.example.com/webhook/%25ffsuper-secret-token",
            "https://real.example.com/webhook/%ed%a0%80super-secret-token",
        ],
    )
    async def test_resolved_base_unsafe_path_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path, resolved_base
    ):
        """Secret-backed auth.base paths must reject unsafe path syntax."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base=resolved_base,
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_no_rewrite_when_resolved_base_empty_string(self, real_flow, mitm_ctx, tmp_path):
        """Empty string base from server uses standard auth injection."""
        flow, allow, vm_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            auth_overrides={
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {"Authorization": "Bearer real-token"},
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["TOKEN", "API_KEY"],
            },
        )
        token_meta["base"] = ""
        original_url = urlparse(flow.request.url)
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        updated_url = urlparse(flow.request.url)
        assert updated_url.scheme == original_url.scheme
        assert updated_url.netloc == original_url.netloc
        assert updated_url.path == original_url.path
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.query["api_key"] == "resolved-key"
        assert flow.metadata["auth_resolved_secrets"] == ["TOKEN", "API_KEY"]
