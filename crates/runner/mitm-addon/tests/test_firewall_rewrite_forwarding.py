"""auth.base rewrite forwarding handler tests."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import auth
import auth_base_forwarder as forwarder
import flow_metadata_keys as metadata_keys
from aws_sigv4 import AwsSigV4Credentials
from generated.builtin_firewalls import BUILTIN_FIREWALLS
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_rewrite_helpers import make_forwarding_rewrite_inputs
from tests.jsonl_log_helpers import read_jsonl_text_after_flush


def _templated_builtin_auth_header_names() -> list[str]:
    names: set[str] = set()
    for firewall in BUILTIN_FIREWALLS.values():
        for api in firewall.get("apis", []):
            auth_headers = api.get("auth", {}).get("headers", {})
            for name, value in auth_headers.items():
                if isinstance(name, str) and isinstance(value, str) and "${{" in value:
                    names.add(name)
    return sorted(names, key=str.lower)


def _request_line_parts(upstream) -> tuple[str, str, str]:
    return upstream.socket.request_lines()[0].split(" ", 2)


class TestAuthBaseUrlRewriteForwarding:
    """auth.base rewrite forwarding handler tests."""

    async def test_url_rewrite_uses_real_forwarder_response(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Handler auth.base rewrites should drive the real forwarder path."""
        request_body = b'{"message":"hello"}'
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            resolved_base="https://real.example.com/webhook/secret?base=trusted",
            rel_path="/send",
            method="POST",
            request_body=request_body,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("X-Keep", "client"),
            ),
            auth_overrides={
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["WEBHOOK", "API_KEY"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(proxy_log_path)

        with (
            fake_forwarder_upstream(
                status=201,
                body=b'{"ok":true}',
                headers=[
                    ("Set-Cookie", "a=1"),
                    ("Set-Cookie", "b=2"),
                    ("Content-Type", "application/json"),
                    ("X-Upstream", "real"),
                ],
            ) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert upstream.getaddrinfo_calls == [("real.example.com", 443)]
        assert upstream.create_connection_calls
        assert upstream.create_connection_calls[0][0] == ("93.184.216.34", 443)
        assert upstream.contexts[0].server_hostnames == ["real.example.com"]

        request_line = upstream.socket.request_lines()[0]
        _method, request_target, _version = request_line.split(" ", 2)
        rewritten = urlparse(f"https://real.example.com{request_target}")
        rewritten_query = parse_qs(rewritten.query, keep_blank_values=True)
        assert request_line.startswith("POST ")
        assert rewritten.path == "/webhook/secret/send"
        assert rewritten_query == {
            "base": ["trusted"],
            "client": ["visible"],
            "api_key": ["resolved-key"],
        }
        assert upstream.socket.request_header_values("Host") == ["real.example.com"]
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real-token"]
        assert upstream.socket.request_header_values("X-Custom") == ["injected-value"]
        assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
        assert upstream.socket.request_header_values("X-Keep") == ["client"]
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Api-Key") == []
        assert upstream.socket.request_header_values("Content-Length") == [str(len(request_body))]
        assert upstream.socket.request_text().endswith("\r\n\r\n" + request_body.decode("ascii"))

        assert flow.response is not None
        assert flow.response.status_code == 201
        assert flow.response.content == b'{"ok":true}'
        response_pairs = list(flow.response.headers.items(multi=True))
        assert response_pairs.count(("Set-Cookie", "a=1")) == 1
        assert response_pairs.count(("Set-Cookie", "b=2")) == 1
        assert ("Content-Type", "application/json") in response_pairs
        assert ("X-Upstream", "real") in response_pairs

        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == ["WEBHOOK", "API_KEY"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] == ["discord"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] == ["WEBHOOK"]
        assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata

        assert flow.request.path == "/hook?client=visible"
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.headers["Cookie"] == "session=agent"
        assert flow.request.headers["X-Api-Key"] == "agent-api-key"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"

        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "Firewall URL rewrite:" in log_text
        assert "real-token" not in log_text
        assert "webhook/secret" not in log_text

    async def test_url_rewrite_sends_resolved_auth_headers(
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
                ("X-Api-Key", "agent-api-key"),
            ),
        )
        token_meta["headers"] = {
            "Authorization": "Bearer real-token",
            "X-Api-Key": "real-api-key",
            "X-Custom": "injected-value",
        }
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real-token"]
        assert upstream.socket.request_header_values("X-Api-Key") == ["real-api-key"]
        assert upstream.socket.request_header_values("X-Custom") == ["injected-value"]
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.headers["X-Api-Key"] == "agent-api-key"
        assert "X-Custom" not in flow.request.headers

    async def test_url_rewrite_strips_client_credentials_without_resolved_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.base forwarding must not leak placeholder-scoped credentials."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
                ("authorization", "Bearer lower-agent"),
                ("AUTHORIZATION", "Bearer upper-agent"),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Auth-Token", "agent-auth-token"),
                ("Private-Token", "agent-private-token"),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("X-Keep", "client"),
            ),
        )
        token_meta["headers"] = {}
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert upstream.socket.request_header_values("Authorization") == []
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Api-Key") == []
        assert upstream.socket.request_header_values("X-Auth-Token") == []
        assert upstream.socket.request_header_values("Private-Token") == []
        assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
        assert upstream.socket.request_header_values("X-Keep") == ["client"]
        request_headers = list(flow.request.headers.items(multi=True))
        assert ("Authorization", "Bearer agent") in request_headers
        assert ("authorization", "Bearer lower-agent") in request_headers
        assert ("AUTHORIZATION", "Bearer upper-agent") in request_headers
        assert flow.request.headers["Cookie"] == "session=agent"

    async def test_url_rewrite_strips_templated_builtin_auth_headers_without_resolved_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Client-provided templated builtin auth headers must not cross auth.base rewrites."""
        auth_header_names = _templated_builtin_auth_header_names()
        assert auth_header_names
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                *[(name, f"client-{index}") for index, name in enumerate(auth_header_names)],
                ("X-Keep", "client"),
            ),
        )
        token_meta["headers"] = {}
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        for name in auth_header_names:
            assert upstream.socket.request_header_values(name) == []
        assert upstream.socket.request_header_values("X-Keep") == ["client"]

    async def test_url_rewrite_preserves_client_static_metadata_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Client-provided non-secret metadata headers should still reach auth.base targets."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Reap-Version", "2025-02-14"),
                ("X-Api-Version", "2025-11-01"),
                ("X-Snowflake-Authorization-Token-Type", "PROGRAMMATIC_ACCESS_TOKEN"),
            ),
        )
        token_meta["headers"] = {}
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert upstream.socket.request_header_values("Reap-Version") == ["2025-02-14"]
        assert upstream.socket.request_header_values("X-Api-Version") == ["2025-11-01"]
        assert upstream.socket.request_header_values("X-Snowflake-Authorization-Token-Type") == [
            "PROGRAMMATIC_ACCESS_TOKEN"
        ]

    async def test_url_rewrite_preserves_duplicate_headers_and_auth_override(
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
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("X-Remove") == []
        assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real"]

    async def test_url_rewrite_filters_client_and_injected_unsafe_headers(
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
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_header_values("Host") == ["discord.com"]
        assert upstream.socket.request_header_values("Keep-Alive") == []
        assert upstream.socket.request_header_values("Proxy-Authenticate") == []
        assert upstream.socket.request_header_values("Proxy-Authorization") == []
        assert upstream.socket.request_header_values("Proxy-Connection") == []
        assert upstream.socket.request_header_values("TE") == []
        assert upstream.socket.request_header_values("Trailer") == []
        assert upstream.socket.request_header_values("Transfer-Encoding") == []
        assert upstream.socket.request_header_values("Upgrade") == []
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real"]
        assert upstream.socket.request_header_values("X-Injected") == ["trusted"]
        assert upstream.socket.request_header_values("X-Keep") == ["client"]

    async def test_forward_request_rejects_malformed_injected_header(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Malformed resolved auth headers fail before auth.base forwarding."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
        )
        token_meta["headers"] = {
            "Authorization": "Bearer real-token",
            "X-Test": "bad\r\nX-Injected: value",
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        mock_forward.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_resolved_auth_header"
        body = json.loads(flow.response.content)
        assert body["error"] == "invalid_resolved_auth_header"

    async def test_url_rewrite_signs_rewritten_aws_sigv4_request(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        """auth.base forwarding signs the rewritten upstream URL, not the placeholder."""
        placeholder_authorization = (
            "AWS4-HMAC-SHA256 "
            "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
            "SignedHeaders=content-type;host;x-amz-date, "
            "Signature=placeholder"
        )
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://STS.AMAZONAWS.COM:443/",
            method="POST",
            request_body=b"Action=GetCallerIdentity&Version=2011-06-15",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("X-Amz-Date", "20260101T000000Z"),
                ("Authorization", placeholder_authorization),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Amz-Security-Token", "placeholder-session-token"),
            ),
            auth_overrides={
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                },
            },
            token_overrides={
                "aws_sigv4": AwsSigV4Credentials(
                    "AKIDEXAMPLE",
                    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                    "real-session-token",
                ),
            },
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        method, request_target, _version = _request_line_parts(upstream)
        assert method == "POST"
        assert request_target == "/"
        authorization = upstream.socket.request_header_values("Authorization")[0]
        assert upstream.getaddrinfo_calls == [("sts.amazonaws.com", 443)]
        assert upstream.socket.request_header_values("Host") == ["sts.amazonaws.com"]
        assert "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request" in authorization
        assert (
            "Signature=d58b7e131d8f54e75a6ee98fd426242a7bab02e04a9e7eaec5dfad94425ab4ae"
            in authorization
        )
        assert upstream.socket.request_header_values("X-Amz-Security-Token") == [
            "real-session-token"
        ]
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Api-Key") == []
        assert upstream.socket.request_header_values("Content-Length") == ["43"]
        assert upstream.socket.request_text().endswith(
            "\r\n\r\nAction=GetCallerIdentity&Version=2011-06-15"
        )
        assert flow.request.headers["Authorization"] == placeholder_authorization

    async def test_url_rewrite_strips_unrelated_authorization_for_aws_query_sigv4(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        """auth.base query SigV4 ignores unrelated client Authorization headers."""
        placeholder_credential = ("PLACEHOLDER/20260101/us-east-1/sts/aws4_request").replace(
            "/", "%2F"
        )
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path=(
                "/?Action=GetCallerIdentity&Version=2011-06-15"
                "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
                f"&X-Amz-Credential={placeholder_credential}"
                "&X-Amz-Date=20260101T000000Z"
                "&X-Amz-Expires=60"
                "&X-Amz-SignedHeaders=host"
                "&X-Amz-Signature=placeholder"
            ),
            resolved_base="https://STS.AMAZONAWS.COM:443/",
            method="GET",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
                ("Cookie", "session=agent"),
                ("X-Amz-Security-Token", "placeholder-session-token"),
            ),
            auth_overrides={
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                },
            },
            token_overrides={
                "aws_sigv4": AwsSigV4Credentials(
                    "AKIDEXAMPLE",
                    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                    "real-session-token",
                ),
            },
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        method, request_target, _version = _request_line_parts(upstream)
        query = dict(parse_qs(urlparse(request_target).query))
        assert method == "GET"
        assert upstream.getaddrinfo_calls == [("sts.amazonaws.com", 443)]
        assert upstream.socket.request_header_values("Host") == ["sts.amazonaws.com"]
        assert query["X-Amz-Credential"] == ["AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request"]
        assert query["X-Amz-Security-Token"] == ["real-session-token"]
        assert query["X-Amz-Signature"] != ["placeholder"]
        assert upstream.socket.request_header_values("Authorization") == []
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Amz-Security-Token") == []

    async def test_url_rewrite_sends_raw_body_for_any_method(self, real_flow, mitm_ctx, tmp_path):
        """auth.base forwarding does not drop bodies for non-POST methods."""
        request_body = b"\x00\xffdelete-body"
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="DELETE",
            request_body=request_body,
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "DELETE"
        assert upstream.socket.request_header_values("Content-Length") == [str(len(request_body))]
        assert bytes(upstream.socket.sent).endswith(b"\r\n\r\n" + request_body)

    async def test_url_rewrite_sends_empty_raw_body_with_zero_content_length(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """An explicit empty body is distinct from no body for Content-Length."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"",
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "POST"
        assert upstream.socket.request_header_values("Content-Length") == ["0"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_url_rewrite_sends_absent_body_without_content_length(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """A request with no raw body remains distinct from an explicit empty body."""
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="GET",
            request_body=None,
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "GET"
        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_url_rewrite_accepts_body_at_limit(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, vm_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"1234",
        )
        get_headers = AsyncMock(return_value=token_meta)
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert get_headers.await_count == 1
        assert upstream.socket.request_header_values("Content-Length") == ["4"]
        assert upstream.socket.request_text().endswith("\r\n\r\n1234")
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
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
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
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
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
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata

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
        flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(proxy_log_path)
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
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_CONNECTORS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_CACHE_HIT not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        # Success-path log line must not be written.
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "URL rewrite forward failed" in log_text
        assert "Firewall URL rewrite:" not in log_text
        assert f"Firewall {allow.api_entry['base']}:" not in log_text
