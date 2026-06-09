"""Successful auth.base rewrite handler tests."""

import asyncio
from unittest.mock import AsyncMock, patch

from mitmproxy import http

import auth
from tests.firewall_rewrite_helpers import make_allow, make_success_rewrite_inputs


class TestAuthBaseUrlRewriteSuccess:
    """Successful auth.base rewrite handler tests."""

    async def test_url_rewrite_with_rel_path_root(self, real_flow, mitm_ctx, tmp_path):
        """When rel_path is '/', resolved base URL is forwarded as-is."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            auth_overrides={"base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["DISCORD_WEBHOOK_URL"]},
            match_overrides={"name": "discord-webhook", "permission": "send-message"},
        )
        mock_forward = AsyncMock(return_value=(200, b'{"ok":true}', {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.response.status_code == 200

    async def test_url_rewrite_response_preserves_duplicate_headers(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Duplicate upstream response headers survive response construction."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            auth_overrides={"base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["DISCORD_WEBHOOK_URL"]},
            match_overrides={"name": "discord-webhook", "permission": "send-message"},
        )
        response_headers = http.Headers(
            [
                (b"Set-Cookie", b"a=1"),
                (b"Set-Cookie", b"b=2"),
                (b"Link", b"<next>; rel=next"),
                (b"Link", b"<prev>; rel=prev"),
            ]
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", response_headers))

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response.status_code == 200
        assert flow.response.headers.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert flow.response.headers.get_all("Link") == ["<next>; rel=next", "<prev>; rel=prev"]

    async def test_url_rewrite_with_remaining_path(self, real_flow, mitm_ctx, tmp_path):
        """When rel_path has content, it's appended to resolved base in forwarded URL."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            seed_url="https://bitrix.internal/rest/0/placeholder/crm.deal.list.json",
            resolved_base="https://mycompany.bitrix24.com/rest/1/real-token",
            rel_path="/crm.deal.list.json",
            api_base="https://bitrix.internal/rest/{uid}/{code}",
            auth_overrides={"base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["BITRIX_WEBHOOK_URL"]},
            match_overrides={
                "name": "bitrix",
                "permission": "crm",
                "rule": "ANY /crm.{method}",
                "params": {"uid": "0", "code": "placeholder", "method": "deal.list.json"},
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/real-token/crm.deal.list.json"
        )
        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_url_rewrite_preserves_query_string(self, real_flow, mitm_ctx, tmp_path):
        """Query string from original request is preserved in forwarded URL."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/discord-webhook/hook?wait=true",
            auth_overrides={"base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["DISCORD_WEBHOOK_URL"]},
            match_overrides={"name": "discord-webhook", "permission": "send-message"},
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc?wait=true"

    async def test_url_rewrite_resolved_base_with_trailing_slash(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Trailing slash on resolved base is stripped before appending rel_path."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/bitrix/rest/0/placeholder/crm.deal.list",
            resolved_base="https://mycompany.bitrix24.com/rest/1/token/",
            rel_path="/crm.deal.list",
            api_base="https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
            auth_overrides={"base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["BITRIX_WEBHOOK_URL"]},
            match_overrides={
                "name": "bitrix",
                "permission": "crm",
                "rule": "ANY /crm.{method}",
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/token/crm.deal.list"
        )

    async def test_url_rewrite_merges_query_strings(self, real_flow, mitm_ctx, tmp_path):
        """When resolved base has query string and original request also has one, merge with &."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/discord-webhook/hook?wait=true",
            resolved_base="https://example.com/hook?token=abc",
            auth_overrides={"base": "${{ secrets.WEBHOOK_URL }}"},
            token_overrides={"resolved_secrets": ["WEBHOOK_URL"]},
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert mock_forward.call_args[0][0] == "https://example.com/hook?token=abc&wait=true"

    async def test_url_rewrite_auth_query_overrides_base_and_original_query(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """auth.query is the highest-priority trusted query source for URL rewrites."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/discord-webhook/hook?api_key=agent&q=test",
            resolved_base="https://example.com/hook?api_key=base&region=us",
            auth_overrides={
                "base": "${{ secrets.WEBHOOK_URL }}",
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "query": {"api_key": "trusted key"},
                "resolved_secrets": ["WEBHOOK_URL", "API_KEY"],
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://example.com/hook?region=us&q=test&api_key=trusted+key"
        )

    async def test_no_url_rewrite_when_auth_base_absent(self, real_flow, mitm_ctx, tmp_path):
        """Without auth.base, no URL rewriting happens (existing behavior)."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        original_url = flow.request.url
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        allow = make_allow(
            api_entry,
            name="github",
            permission="repo-read",
            rule="GET /repos/{owner}/{repo}",
        )
        token_meta = {
            "headers": {"Authorization": "Bearer real-token"},
            "resolved_secrets": ["GITHUB_TOKEN"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        # URL should not be modified
        assert flow.request.url == original_url
        assert flow.request.headers["Authorization"] == "Bearer real-token"

    async def test_sets_auth_url_rewrite_metadata_and_response(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            token_overrides={
                "resolved_secrets": ["WEBHOOK"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        mock_forward = AsyncMock(
            return_value=(200, b'{"ok":true}', {"Content-Type": "application/json"})
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)
        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["auth_resolved_secrets"] == ["WEBHOOK"]
        assert flow.metadata["auth_refreshed_connectors"] == ["discord"]
        assert flow.metadata["auth_refreshed_secrets"] == ["WEBHOOK"]
        assert flow.metadata["auth_cache_hit"] is False
        assert flow.response is not None
        assert flow.response.status_code == 200
        # forward_request called with the rewritten URL
        call_args = mock_forward.call_args
        assert call_args[0][0] == "https://discord.com/api/webhooks/123/abc"
        log_text = await asyncio.to_thread(
            lambda: proxy_log_path.read_text() if proxy_log_path.exists() else ""
        )
        assert "Firewall URL rewrite:" in log_text
        assert f"Firewall {allow.api_entry['base']}:" in log_text

    async def test_upstream_error_response_is_forwarded(self, real_flow, mitm_ctx, tmp_path):
        """A non-2xx upstream response is still a successful local forward."""
        flow, allow, vm_info, token_meta = make_success_rewrite_inputs(real_flow, tmp_path)
        mock_forward = AsyncMock(
            return_value=(
                500,
                b'{"error":"upstream"}',
                {"Content-Type": "application/json"},
            )
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 500
        assert flow.response.content == b'{"error":"upstream"}'
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert "firewall_error" not in flow.metadata

    async def test_no_auth_url_rewrite_metadata_when_no_base(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is absent when no URL rewrite happens."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        allow = make_allow(
            api_entry, name="gh", permission="read", rule="GET /repos/{owner}/{repo}"
        )
        token_meta = {
            "headers": {"Authorization": "Bearer real"},
            "resolved_secrets": ["TOKEN"],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert "auth_url_rewrite" not in flow.metadata
        # Standard header injection happened
        assert flow.request.headers["Authorization"] == "Bearer real"
