"""Tests for firewall auth URL rewrite."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

from mitmproxy import http

import auth
import matching


def _allow(
    api_entry: dict,
    *,
    name: str = "test",
    permission: str | None = "send",
    params: dict[str, str] | None = None,
    rule: str | None = "POST /",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(api_entry, name, permission, params or {}, rule, rel_path)


def make_rewrite_inputs(
    real_flow,
    tmp_path,
    *,
    path="/hook",
    seed_url=None,
    resolved_base="https://discord.com/api/webhooks/123/abc",
    rel_path="/",
    method="GET",
    request_body=None,
    request_headers=None,
    api_base="https://firewall-placeholder.vm3.ai/discord-webhook/hook",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    # ``seed_url`` lets callers specify a scheme://host/path?query to seed
    # the request without mutating read-only mitmproxy Request properties.
    if seed_url:
        parsed = urlparse(seed_url)
        host = parsed.hostname or "firewall-placeholder.vm3.ai"
        real_path = parsed.path or "/"
        if parsed.query:
            real_path = f"{real_path}?{parsed.query}"
        flow = real_flow(
            with_response=False,
            host=host,
            path=real_path,
            method=method,
            request_body=request_body,
            request_headers=request_headers,
        )
    else:
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path=path,
            method=method,
            request_body=request_body,
            request_headers=request_headers,
        )
    flow.metadata["vm_run_id"] = "test-run"

    auth_config = {"headers": {}, "base": "${{ secrets.WEBHOOK }}"}
    if auth_overrides:
        auth_config.update(auth_overrides)
    api_entry = {
        "base": api_base,
        "auth": auth_config,
    }
    vm_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "billableFirewalls": [],
    }
    allow_kwargs = {
        "name": "test",
        "permission": "send",
        "rule": "POST /",
        "params": {},
        "rel_path": rel_path,
    }
    if match_overrides:
        allow_kwargs.update(match_overrides)
    allow = _allow(api_entry, **allow_kwargs)
    token_meta = {
        "headers": {},
        "base": resolved_base,
        "resolved_secrets": ["WEBHOOK"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }
    if token_overrides:
        token_meta.update(token_overrides)
    return flow, allow, vm_info, token_meta


class TestAuthBaseUrlRewrite:
    """Tests for auth.base URL rewriting via forward_request in handle_firewall_request."""

    async def test_url_rewrite_with_rel_path_root(self, real_flow, mitm_ctx, tmp_path):
        """When rel_path is '/', resolved base URL is forwarded as-is."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        allow = _allow(
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


class TestAuthBaseUrlRewriteEdgeCases:
    """Integration tests for auth.base URL rewriting via forward_request."""

    async def test_sets_auth_url_rewrite_metadata_and_response(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(real_flow, tmp_path)
        mock_forward = AsyncMock(
            return_value=(200, b'{"ok":true}', {"Content-Type": "application/json"})
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.response is not None
        assert flow.response.status_code == 200
        # forward_request called with the rewritten URL
        call_args = mock_forward.call_args
        assert call_args[0][0] == "https://discord.com/api/webhooks/123/abc"

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
        allow = _allow(api_entry, name="gh", permission="read", rule="GET /repos/{owner}/{repo}")
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

    async def test_forward_request_includes_auth_headers(self, real_flow, mitm_ctx, tmp_path):
        """auth.headers are included in the forwarded request to the real URL."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Auth headers passed to forward_request.
        call_args = mock_forward.call_args
        req_headers = call_args[0][2]
        assert ("X-Custom", "injected-value") in req_headers

    async def test_forward_request_preserves_duplicate_headers_and_auth_override(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.base forwarding keeps repeated headers unless auth overrides that name."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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

    async def test_forward_failure_returns_502(self, real_flow, mitm_ctx, tmp_path):
        """forward_request exception produces a 502 error response and marks
        firewall_error without falling through to the success-path metadata.

        Regression for #10341: the except block previously lacked a ``return``,
        so ``auth_url_rewrite`` and a misleading ``Firewall URL rewrite`` info
        log were emitted on failure, and ``firewall_error`` was left unset —
        making failed rewrites indistinguishable from successful ones in
        dashboards."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(real_flow, tmp_path)
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
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
        # Success-path log line must not be written.
        log_path = Path(vm_info["networkLogPath"])
        log_text = await asyncio.to_thread(
            lambda: log_path.read_text() if log_path.exists() else ""
        )
        assert "Firewall URL rewrite:" not in log_text

    async def test_forward_failure_does_not_log_resolved_url_secret(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Forward errors must not leak secret-bearing resolved auth.base URLs."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(
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
        log_args = mock_log.call_args.args
        log_kwargs = mock_log.call_args.kwargs
        assert "super-secret-token" not in json.dumps(log_args)
        assert "super-secret-token" not in json.dumps(log_kwargs)

    async def test_no_rewrite_when_resolved_base_empty_string(self, real_flow, mitm_ctx, tmp_path):
        """Empty string base from server is treated as absent — no URL rewrite."""
        flow, allow, vm_info, token_meta = make_rewrite_inputs(real_flow, tmp_path)
        token_meta["base"] = ""
        original_url = flow.request.url
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.request.url == original_url
        assert "auth_url_rewrite" not in flow.metadata
