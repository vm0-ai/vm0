"""Tests for firewall auth URL rewrite and query injection."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

from mitmproxy import http

import auth
import url_utils


class TestAuthBaseUrlRewrite:
    """Tests for auth.base URL rewriting via forward_request in handle_firewall_request."""

    async def test_url_rewrite_with_rel_path_root(self, real_flow, headers, mitm_ctx, tmp_path):
        """When rel_path is '/', resolved base URL is forwarded as-is."""
        flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path="/hook")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "discord-webhook",
            "permission": "send-message",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://discord.com/api/webhooks/123/abc",
            "resolved_secrets": ["DISCORD_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b'{"ok":true}', {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.response.status_code == 200

    async def test_url_rewrite_response_preserves_duplicate_headers(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Duplicate upstream response headers survive response construction."""
        flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path="/hook")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "discord-webhook",
            "permission": "send-message",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://discord.com/api/webhooks/123/abc",
            "resolved_secrets": ["DISCORD_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
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
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response.status_code == 200
        assert flow.response.headers.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert flow.response.headers.get_all("Link") == ["<next>; rel=next", "<prev>; rel=prev"]

    async def test_url_rewrite_with_remaining_path(self, real_flow, headers, mitm_ctx, tmp_path):
        """When rel_path has content, it's appended to resolved base in forwarded URL."""
        flow = real_flow(
            with_response=False,
            host="bitrix.internal",
            path="/rest/0/placeholder/crm.deal.list.json",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://bitrix.internal/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "bitrix",
            "permission": "crm",
            "rule": "ANY /crm.{method}",
            "params": {"uid": "0", "code": "placeholder", "method": "deal.list.json"},
            "rel_path": "/crm.deal.list.json",
        }
        token_meta = {
            "headers": {},
            "base": "https://mycompany.bitrix24.com/rest/1/real-token",
            "resolved_secrets": ["BITRIX_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/real-token/crm.deal.list.json"
        )
        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_url_rewrite_preserves_query_string(self, real_flow, headers, mitm_ctx, tmp_path):
        """Query string from original request is preserved in forwarded URL."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/discord-webhook/hook?wait=true",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "discord-webhook",
            "permission": "send-message",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://discord.com/api/webhooks/123/abc",
            "resolved_secrets": ["DISCORD_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc?wait=true"

    async def test_url_rewrite_resolved_base_with_trailing_slash(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Trailing slash on resolved base is stripped before appending rel_path."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/bitrix/rest/0/placeholder/crm.deal.list",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "bitrix",
            "permission": "crm",
            "rule": "ANY /crm.{method}",
            "params": {},
            "rel_path": "/crm.deal.list",
        }
        token_meta = {
            "headers": {},
            "base": "https://mycompany.bitrix24.com/rest/1/token/",
            "resolved_secrets": ["BITRIX_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/token/crm.deal.list"
        )

    async def test_url_rewrite_merges_query_strings(self, real_flow, headers, mitm_ctx, tmp_path):
        """When resolved base has query string and original request also has one, merge with &."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/discord-webhook/hook?wait=true",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://example.com/hook?token=abc",
            "resolved_secrets": ["WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://example.com/hook?token=abc&wait=true"

    async def test_url_rewrite_auth_query_overrides_base_and_original_query(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """auth.query is the highest-priority trusted query source for URL rewrites."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/discord-webhook/hook?api_key=agent&q=test",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {
                "headers": {},
                "base": "${{ secrets.WEBHOOK_URL }}",
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://example.com/hook?api_key=base&region=us",
            "query": {"api_key": "trusted key"},
            "resolved_secrets": ["WEBHOOK_URL", "API_KEY"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://example.com/hook?region=us&q=test&api_key=trusted+key"
        )

    async def test_no_url_rewrite_when_auth_base_absent(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
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
        match_info = {
            "name": "github",
            "permission": "repo-read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {},
        }
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
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        # URL should not be modified
        assert flow.request.url == original_url
        assert flow.request.headers["Authorization"] == "Bearer real-token"


class TestBuildRewriteUrl:
    """Unit tests for _build_rewrite_url (pure URL construction)."""

    def test_simple_base_no_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://discord.com/api/webhooks/123/abc",
            {"rel_path": "/"},
            "",
        )
        assert url == "https://discord.com/api/webhooks/123/abc"

    def test_multi_segment_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base",
            {"rel_path": "/a/b/c"},
            "",
        )
        assert url == "https://example.com/base/a/b/c"

    def test_base_with_query_no_orig_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_empty_orig_query_ignored(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {"rel_path": "/"},
            "",
        )
        assert url == "https://example.com/hook"

    def test_rel_path_with_both_queries_merged(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=abc",
            {"rel_path": "/sub"},
            "extra=1",
        )
        assert url == "https://example.com/hook/sub?token=abc&extra=1"

    def test_original_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_followed_by_empty_segment_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "token=attacker&&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_preceded_by_empty_segment_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "wait=true&&token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_all_original_duplicate_query_keys_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "token=first&token=second",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_original_encoded_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "to%6ben=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_of_encoded_trusted_base_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?to%6ben=secret",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?to%6ben=secret&wait=true"

    def test_original_plus_encoded_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api+key=secret",
            {"rel_path": "/"},
            "api%20key=attacker&wait=true",
        )
        assert url == "https://example.com/hook?api+key=secret&wait=true"

    def test_original_semicolon_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "wait=true;token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_before_kept_pair_uses_source_separator(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_between_kept_pairs_uses_safe_separator(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "keep=1;token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&keep=1&wait=true"

    def test_duplicate_trusted_base_query_keys_preserved(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=first&token=second",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first&token=second&wait=true"

    def test_duplicate_trusted_base_query_keys_with_semicolon_preserved(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=first;token=second",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first;token=second&wait=true"

    def test_blank_trusted_base_query_value_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=&wait=true"

    def test_valueless_trusted_base_query_key_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token",
            {"rel_path": "/"},
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token&wait=true"

    def test_empty_trusted_base_query_key_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?=secret",
            {"rel_path": "/"},
            "=attacker&wait=true",
        )
        assert url == "https://example.com/hook?=secret&wait=true"

    def test_empty_trusted_base_query_segments_do_not_block_empty_original_key(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?&&region=us",
            {"rel_path": "/"},
            "=agent&q=test",
        )
        assert url == "https://example.com/hook?&&region=us&=agent&q=test"

    def test_auth_query_overrides_base_and_original_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base&region=us",
            {"rel_path": "/"},
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_empty_key_overrides_base_and_original_empty_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?=base&region=us",
            {"rel_path": "/"},
            "=agent&q=test",
            {"": "trusted"},
        )
        assert url == "https://example.com/hook?region=us&q=test&=trusted"

    def test_auth_query_overrides_base_query_without_leading_empty_segment(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base&&region=us",
            {"rel_path": "/"},
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_base_query_without_trailing_empty_segment(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?region=us&&api_key=base",
            {"rel_path": "/"},
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_all_lower_priority_duplicates(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base",
            {"rel_path": "/"},
            "api_key=agent",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?api_key=trusted+key"

    def test_auth_query_overrides_duplicate_trusted_base_query_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=first&api_key=second&region=us",
            {"rel_path": "/"},
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_encoded_base_and_original_query_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api%5Fkey=base&region=us",
            {"rel_path": "/"},
            "api%5fkey=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_plus_encoded_lower_priority_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api+key=base&region=us",
            {"rel_path": "/"},
            "api%20key=agent&q=test",
            {"api key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api+key=trusted+key"

    def test_auth_query_overrides_semicolon_base_without_prefixing_kept_pair(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base;region=us",
            {"rel_path": "/"},
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_semicolon_base_between_kept_pairs(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?tenant=one;api_key=base;region=us",
            {"rel_path": "/"},
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?tenant=one&region=us&q=test&api_key=trusted+key"

    def test_auth_query_filter_preserves_existing_semicolon_value(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?redirect=a;b&api_key=base&region=us",
            {"rel_path": "/"},
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?redirect=a;b&region=us&q=test&api_key=trusted+key"

    def test_trailing_slash_on_base_deduped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/",
            {"rel_path": "/sub"},
            "",
        )
        assert url == "https://example.com/hook/sub"

    def test_no_rel_path_key_defaults_to_root(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {},
            "",
        )
        assert url == "https://example.com/hook"


class TestAuthBaseUrlRewriteEdgeCases:
    """Integration tests for auth.base URL rewriting via forward_request."""

    def _make_rewrite_inputs(
        self,
        real_flow,
        tmp_path,
        *,
        path="/hook",
        seed_url=None,
        resolved_base="https://discord.com/api/webhooks/123/abc",
        rel_path="/",
    ):
        # ``seed_url`` lets callers specify a scheme://host/path?query to
        # seed the request. We parse it back into ``real_flow`` kwargs
        # rather than mutating the read-only ``Request`` properties.
        if seed_url:
            parsed = urlparse(seed_url)
            host = parsed.hostname or "firewall-placeholder.vm3.ai"
            real_path = parsed.path or "/"
            if parsed.query:
                real_path = f"{real_path}?{parsed.query}"
            flow = real_flow(with_response=False, host=host, path=real_path)
        else:
            flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path=path)
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": rel_path,
        }
        token_meta = {
            "headers": {},
            "base": resolved_base,
            "resolved_secrets": ["WEBHOOK"],
            "cache_hit": False,
        }
        return flow, api_entry, vm_info, match_info, token_meta

    async def test_sets_auth_url_rewrite_metadata_and_response(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        mock_forward = AsyncMock(
            return_value=(200, b'{"ok":true}', {"Content-Type": "application/json"})
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.response is not None
        assert flow.response.status_code == 200
        # forward_request called with the rewritten URL
        call_args = mock_forward.call_args
        assert call_args[0][0] == "https://discord.com/api/webhooks/123/abc"

    async def test_no_auth_url_rewrite_metadata_when_no_base(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
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
        match_info = {
            "name": "gh",
            "permission": "read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real"},
            "resolved_secrets": ["TOKEN"],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert "auth_url_rewrite" not in flow.metadata
        # Standard header injection happened
        assert flow.request.headers["Authorization"] == "Bearer real"

    async def test_forward_request_includes_auth_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.headers are included in the forwarded request to the real URL."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
        )
        token_meta["headers"] = {"X-Custom": "injected-value"}
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Auth headers passed to forward_request (in the headers dict)
        call_args = mock_forward.call_args
        req_headers = call_args[0][2]
        assert req_headers["X-Custom"] == "injected-value"

    async def test_forward_failure_returns_502(self, real_flow, mitm_ctx, tmp_path):
        """forward_request exception produces a 502 error response and marks
        firewall_error without falling through to the success-path metadata.

        Regression for #10341: the except block previously lacked a ``return``,
        so ``auth_url_rewrite`` and a misleading ``Firewall URL rewrite`` info
        log were emitted on failure, and ``firewall_error`` was left unset —
        making failed rewrites indistinguishable from successful ones in
        dashboards."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.response is not None
        assert flow.response.status_code == 502
        body = json.loads(flow.response.content)
        assert body["error"] == "url_rewrite_forward_failed"
        # Failure must not masquerade as a successful rewrite.
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        # Success-path log line must not be written.
        log_path = Path(vm_info["networkLogPath"])
        log_text = await asyncio.to_thread(
            lambda: log_path.read_text() if log_path.exists() else ""
        )
        assert "Firewall URL rewrite:" not in log_text

    async def test_no_rewrite_when_resolved_base_empty_string(self, real_flow, mitm_ctx, tmp_path):
        """Empty string base from server is treated as absent — no URL rewrite."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        token_meta["base"] = ""
        original_url = flow.request.url
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.url == original_url
        assert "auth_url_rewrite" not in flow.metadata


# =========================================================================
# auth.query injection
# =========================================================================


class TestAuthQueryInjection:
    """Tests for query parameter injection via auth.query."""

    async def test_query_params_injected_on_standard_path(self, real_flow, headers, mitm_ctx):
        """Resolved auth.query params are injected into flow.request.query."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://serpapi.com",
            "auth": {"headers": {}, "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "serpapi",
            "permission": "search",
            "rule": "GET /search",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": ["SERPAPI_TOKEN"],
            "cache_hit": False,
            "query": {"api_key": "resolved-key-123"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.request.query["api_key"] == "resolved-key-123"

    async def test_query_param_overwrites_existing_key(self, real_flow, headers, mitm_ctx):
        """auth.query overwrites a query param already present in the original request."""
        flow = real_flow(
            with_response=False,
            host="serpapi.com",
            path="/search?api_key=agent-value&q=test",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://serpapi.com",
            "auth": {"headers": {}, "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "serpapi",
            "permission": "search",
            "rule": "GET /search",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": ["SERPAPI_TOKEN"],
            "cache_hit": False,
            "query": {"api_key": "real-secret-key"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        # auth.query overwrites the agent's api_key
        assert flow.request.query["api_key"] == "real-secret-key"
        # Other query params are preserved
        assert flow.request.query["q"] == "test"

    async def test_query_params_with_headers_simultaneously(self, real_flow, headers, mitm_ctx):
        """auth.query and auth.headers can coexist on the standard path."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://example.com",
            "auth": {
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"key": "${{ secrets.QUERY_KEY }}"},
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "ex",
            "permission": "read",
            "rule": "GET /data",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real-token"},
            "resolved_secrets": ["TOKEN", "QUERY_KEY"],
            "cache_hit": False,
            "query": {"key": "resolved-query-value"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.query["key"] == "resolved-query-value"

    async def test_query_params_merged_into_rewrite_url(self, real_flow, headers, mitm_ctx):
        """auth.query params are appended to the forwarded URL in the URL rewrite path."""
        flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path="/hook")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/webhook/hook",
            "auth": {
                "headers": {},
                "base": "${{ secrets.WEBHOOK }}",
                "query": {"api_key": "${{ secrets.KEY }}"},
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://real-api.com/webhook/secret",
            "resolved_secrets": ["WEBHOOK", "KEY"],
            "cache_hit": False,
            "query": {"api_key": "resolved-key-456"},
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Verify the forwarded URL contains the auth.query params
        call_args = mock_forward.call_args
        forwarded_url = call_args[0][0]
        assert "api_key=resolved-key-456" in forwarded_url
        assert forwarded_url.startswith("https://real-api.com/webhook/secret")

    async def test_no_query_injection_when_absent(self, real_flow, headers, mitm_ctx):
        """No query modification when auth.query is not present."""
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
            "billableFirewalls": [],
        }
        match_info = {
            "name": "gh",
            "permission": "read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real"},
            "resolved_secrets": ["TOKEN"],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.headers["Authorization"] == "Bearer real"
        # No query params should have been added
        assert len(flow.request.query) == 0
