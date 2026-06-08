"""Tests for firewall auth query injection."""

from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

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


def make_query_inputs(
    real_flow,
    *,
    host="api.github.com",
    path="/repos",
    api_base="https://serpapi.com",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    flow = real_flow(with_response=False, host=host, path=path)
    flow.metadata["vm_run_id"] = "test-run"
    auth_config = {
        "headers": {},
        "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"},
    }
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
        "billableFirewalls": [],
    }
    allow_kwargs = {
        "name": "serpapi",
        "permission": "search",
        "rule": "GET /search",
        "params": {},
    }
    if match_overrides:
        allow_kwargs.update(match_overrides)
    allow = _allow(api_entry, **allow_kwargs)
    token_meta = {
        "headers": {},
        "resolved_secrets": ["SERPAPI_TOKEN"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
        "query": {"api_key": "resolved-key-123"},
    }
    if token_overrides:
        token_meta.update(token_overrides)
    return flow, allow, vm_info, token_meta


# =========================================================================
# auth.query injection
# =========================================================================


class TestAuthQueryInjection:
    """Tests for query parameter injection via auth.query."""

    async def test_query_params_injected_on_standard_path(self, real_flow, mitm_ctx):
        """Resolved auth.query params are injected into flow.request.query."""
        flow, allow, vm_info, token_meta = make_query_inputs(
            real_flow,
            auth_overrides={
                "query": {
                    "api_key": "${{ secrets.SERPAPI_TOKEN }}",
                    "empty_auth": "${{ vars.EMPTY }}",
                    "space": "${{ vars.SPACE }}",
                },
            },
            token_overrides={
                "query": {
                    "api_key": "resolved-key-123",
                    "empty_auth": "",
                    "space": "a b",
                }
            },
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)
        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.request.query["api_key"] == "resolved-key-123"
        assert flow.request.query["empty_auth"] == ""
        assert flow.request.query["space"] == "a b"

    async def test_query_param_overwrites_existing_key(self, real_flow, mitm_ctx):
        """auth.query overwrites a query param already present in the original request."""
        flow, allow, vm_info, token_meta = make_query_inputs(
            real_flow,
            host="serpapi.com",
            path=(
                "/search?api_key=agent-value&api_key=stale-value"
                "&q=test&empty=&repeat=one&repeat=two"
            ),
            token_overrides={"query": {"api_key": "real-secret-key"}},
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        # auth.query overwrites the agent's api_key
        assert flow.request.query["api_key"] == "real-secret-key"
        assert list(flow.request.query.get_all("api_key")) == ["real-secret-key"]
        # Other query params are preserved
        assert flow.request.query["q"] == "test"
        assert flow.request.query["empty"] == ""
        query_items = list(flow.request.query.items(multi=True))
        assert query_items.count(("repeat", "one")) == 1
        assert query_items.count(("repeat", "two")) == 1

    async def test_query_params_with_headers_simultaneously(self, real_flow, mitm_ctx):
        """auth.query and auth.headers can coexist on the standard path."""
        flow, allow, vm_info, token_meta = make_query_inputs(
            real_flow,
            api_base="https://example.com",
            auth_overrides={
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"key": "${{ secrets.QUERY_KEY }}"},
            },
            token_overrides={
                "headers": {"Authorization": "Bearer real-token"},
                "resolved_secrets": ["TOKEN", "QUERY_KEY"],
                "query": {"key": "resolved-query-value"},
            },
            match_overrides={"name": "ex", "permission": "read", "rule": "GET /data"},
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.query["key"] == "resolved-query-value"

    async def test_query_params_merged_into_rewrite_url(self, real_flow, mitm_ctx):
        """auth.query params are forwarded without mutating the placeholder request."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/hook?client=visible",
        )
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
        allow = _allow(api_entry)
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
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Verify the forwarded URL contains the auth.query params
        call_args = mock_forward.call_args
        forwarded_url = call_args[0][0]
        query = parse_qs(urlparse(forwarded_url).query)
        assert query["api_key"] == ["resolved-key-456"]
        assert query["client"] == ["visible"]
        assert forwarded_url.startswith("https://real-api.com/webhook/secret")
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"

    async def test_query_params_overwrite_existing_rewrite_url_keys(self, real_flow, mitm_ctx):
        """auth.query overwrites duplicate keys while preserving other query values."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/hook?api_key=agent-key&q=test&empty=&repeat=one&repeat=two",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/webhook/hook",
            "auth": {
                "headers": {},
                "base": "${{ secrets.WEBHOOK }}",
                "query": {
                    "api_key": "${{ secrets.KEY }}",
                    "empty_auth": "${{ vars.EMPTY }}",
                    "space": "${{ vars.SPACE }}",
                },
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        allow = _allow(api_entry)
        token_meta = {
            "headers": {},
            "base": "https://real-api.com/webhook/secret?api_key=base-key&mode=fast&base_empty=",
            "resolved_secrets": ["WEBHOOK", "KEY"],
            "cache_hit": False,
            "query": {
                "api_key": "resolved-key-456",
                "empty_auth": "",
                "space": "a b",
            },
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        forwarded = urlparse(mock_forward.call_args[0][0])
        query = parse_qs(forwarded.query, keep_blank_values=True)
        assert forwarded.scheme == "https"
        assert forwarded.netloc == "real-api.com"
        assert forwarded.path == "/webhook/secret"
        assert query["api_key"] == ["resolved-key-456"]
        assert query["mode"] == ["fast"]
        assert query["base_empty"] == [""]
        assert query["q"] == ["test"]
        assert query["empty"] == [""]
        assert query["empty_auth"] == [""]
        assert query["space"] == ["a b"]
        assert query["repeat"] == ["one", "two"]

    async def test_query_params_preserve_rewrite_path_params(self, real_flow, mitm_ctx):
        """auth.query merging must not strip URL path params from the rewrite target."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/hook/callback;matrix=1?q=test",
        )
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
        allow = _allow(api_entry, rel_path="/callback;matrix=1")
        token_meta = {
            "headers": {},
            "base": "https://real-api.com/webhook/secret;v=1?mode=fast",
            "resolved_secrets": ["WEBHOOK", "KEY"],
            "cache_hit": False,
            "query": {"api_key": "resolved-key"},
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        forwarded = urlparse(mock_forward.call_args[0][0])
        assert forwarded.path == "/webhook/secret;v=1/callback"
        assert forwarded.params == "matrix=1"
        query = parse_qs(forwarded.query, keep_blank_values=True)
        assert query == {
            "mode": ["fast"],
            "q": ["test"],
            "api_key": ["resolved-key"],
        }

    async def test_no_query_injection_when_absent(self, real_flow, mitm_ctx):
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
        assert flow.request.headers["Authorization"] == "Bearer real"
        # No query params should have been added
        assert len(flow.request.query) == 0
