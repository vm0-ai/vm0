"""Billable usage tracking lifecycle tests for the request hook."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

_ForwardResponse = tuple[int, bytes, dict[str, str]]


class _ForwardProbe:
    def __init__(
        self,
        *,
        response: _ForwardResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        if response is None and error is None:
            raise ValueError("forward probe requires a response or error")
        if response is not None and error is not None:
            raise ValueError("forward probe accepts only one response or error")

        self.started: asyncio.Event = asyncio.Event()
        self.release: asyncio.Event = asyncio.Event()
        self.calls = 0
        self._response: _ForwardResponse = (
            response if response is not None else (500, b"", dict[str, str]())
        )
        self._error: Exception | None = error

    async def __call__(self, *_args: object) -> _ForwardResponse:
        self.calls += 1
        self.started.set()
        await self.release.wait()
        if self._error is not None:
            raise self._error
        return self._response


async def _wait_for_forward_start(probe: _ForwardProbe, request_task: asyncio.Task[None]) -> None:
    started_task = asyncio.create_task(probe.started.wait())
    try:
        done, _ = await asyncio.wait(
            (started_task, request_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if started_task in done:
            return

        try:
            await request_task
        except asyncio.CancelledError as e:
            raise AssertionError("request finished before forward_request started") from e
        except Exception as e:
            raise AssertionError("request finished before forward_request started") from e
        raise AssertionError("request finished before forward_request started")
    finally:
        if not started_task.done():
            started_task.cancel()
            await asyncio.gather(started_task, return_exceptions=True)


async def _release_forward_probe(probe: _ForwardProbe, request_task: asyncio.Task[None]) -> None:
    probe.release.set()
    if not request_task.done():
        await asyncio.gather(request_task, return_exceptions=True)


async def _await_request_task(request_task: asyncio.Task[None]) -> None:
    result = (await asyncio.gather(request_task, return_exceptions=True))[0]
    if isinstance(result, BaseException):
        raise result


@pytest.fixture
def usage_pending_path(tmp_path: Path) -> Iterator[Path]:
    pending_path = tmp_path / "usage-pending"
    usage.counters.reset_for_tests()
    usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
    try:
        yield pending_path
    finally:
        usage.counters.reset_for_tests()


async def test_billable_flow_is_tracked_before_responseheaders(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    """Drain sees billable requests after request() even before responseheaders()."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="x",
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
            },
            network_policy={
                "allow": ["read-posts"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["x"],
        ),
    )

    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["_usage_flow_tracked"] is True
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=1,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_local_firewall_error_does_not_track_usage_flow(
    tmp_path, usage_pending_path, real_flow, mitm_ctx, headers
):
    """Local auth failures do not enqueue usage and must not leak drain counters."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="x",
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
            },
            network_policy={
                "allow": ["read-posts"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["x"],
            include_encrypted_secrets=False,
        ),
    )

    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata["firewall_error"] == "auth_unavailable"
    assert "_usage_flow_tracked" not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_unexpected_request_exception_releases_tracking(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Unexpected request-hook failures must not leak start-time or usage counters."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="x",
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
            },
            network_policy={
                "allow": ["read-posts"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["x"],
        ),
    )

    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value={})),
        pytest.raises(KeyError),
    ):
        await mitm_addon.request(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_non_billable_model_provider_is_not_tracked_before_responseheaders(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    """Model-provider usage only reports when the firewall is billable."""
    firewall_name = "model-provider:anthropic-api-key"
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-model-1",
            sandbox_marker="tok-model",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://api.anthropic.com",
                "auth": {"headers": {"x-api-key": "test-key"}},
                "permissions": [{"name": "messages", "rules": ["POST /v1/messages"]}],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.anthropic.com",
        path="/v1/messages",
        method="POST",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_name"] == firewall_name
    assert flow.metadata["cli_agent_type"] == "claude-code"
    assert flow.metadata["firewall_billable"] is False
    assert "_usage_flow_tracked" not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_model_provider_records_model_usage_provider(
    tmp_path, usage_pending_path, real_flow, mitm_ctx, fake_firewall_headers
):
    """Registry modelUsageProvider is available to model usage reporting."""
    firewall_name = "model-provider:anthropic-api-key"
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-model-1",
            sandbox_marker="tok-model",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://api.anthropic.com",
                "auth": {"headers": {"x-api-key": "test-key"}},
                "permissions": [{"name": "messages", "rules": ["POST /v1/messages"]}],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name],
            vm_fields={
                "cliAgentType": "codex",
                "modelUsageProvider": "claude-opus-4-6",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.anthropic.com",
        path="/v1/messages",
        method="POST",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_name"] == firewall_name
    assert flow.metadata["cli_agent_type"] == "codex"
    assert flow.metadata["firewall_billable"] is True
    assert flow.metadata["model_usage_provider"] == "claude-opus-4-6"
    assert flow.metadata["_usage_flow_tracked"] is True
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=1,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_auth_url_rewrite_flow_drains_after_response(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Inline auth.base responses still pair request-time tracking with response()."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-rewrite-1",
            sandbox_marker="tok-rewrite",
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["POST /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["webhook"],
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        path="/",
        method="POST",
        request_body=b'{"ok":true}',
    )
    token_meta = {
        "headers": {},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }
    probe = _ForwardProbe(
        response=(200, b'{"delivered":true}', {"Content-Type": "application/json"})
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(return_value=token_meta),
        ),
        patch.object(
            auth,
            "forward_request",
            probe,
        ),
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_forward_start(probe, request_task)

            assert probe.calls == 1
            assert flow.metadata["_usage_flow_tracked"] is True
            usage.write_pending_snapshot(flush_request_id="request-1")
            assert_pending(
                usage_pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )

            probe.release.set()
            await _await_request_task(request_task)
        finally:
            if not request_task.done():
                await _release_forward_probe(probe, request_task)

        assert flow.response is not None
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.metadata["_usage_flow_tracked"] is True
        usage.write_pending_snapshot(flush_request_id="request-1")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )

        mitm_addon.response(flow)

    assert "_usage_flow_tracked" not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_auth_url_rewrite_forward_failure_releases_tracking(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Failed inline auth.base forwarding is a local response and drains immediately."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-rewrite-1",
            sandbox_marker="tok-rewrite",
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["POST /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["webhook"],
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        path="/",
        method="POST",
        request_body=b'{"ok":true}',
    )
    token_meta = {
        "headers": {},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }
    probe = _ForwardProbe(error=RuntimeError("upstream unavailable"))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(return_value=token_meta),
        ),
        patch.object(
            auth,
            "forward_request",
            probe,
        ),
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_forward_start(probe, request_task)

            assert probe.calls == 1
            assert flow.metadata["_usage_flow_tracked"] is True
            usage.write_pending_snapshot(flush_request_id="request-1")
            assert_pending(
                usage_pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )

            probe.release.set()
            await _await_request_task(request_task)
        finally:
            if not request_task.done():
                await _release_forward_probe(probe, request_task)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
    assert "auth_url_rewrite" not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )
