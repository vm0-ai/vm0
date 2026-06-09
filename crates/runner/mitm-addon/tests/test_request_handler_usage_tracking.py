"""Billable usage tracking lifecycle tests for the request hook."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy.flow import Error

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

_ForwardResponse = tuple[int, bytes, dict[str, str]]
_X_FIREWALL_NAME = "x"
_X_TRACKING_PATH = "/2/users/by"
_DEFAULT_RUN_ID = "run-conn-1"
_DEFAULT_SANDBOX_MARKER = "tok-conn"
_MODEL_PROVIDER_FIREWALL_NAME = "model-provider:anthropic-api-key"
_MODEL_PROVIDER_RUN_ID = "run-model-1"
_MODEL_PROVIDER_SANDBOX_MARKER = "tok-model"
_MODEL_PROVIDER_PATH = "/v1/messages"
_AUTH_URL_REWRITE_REQUEST_BODY = b'{"ok":true}'


class _ForwardProbe:
    def __init__(
        self,
        *,
        response: _ForwardResponse | None = None,
        error: BaseException | None = None,
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
        self._error: BaseException | None = error

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


def _write_billable_x_tracking_registry(
    tmp_path: Path,
    *,
    include_encrypted_secrets: bool = True,
) -> Path:
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name=_X_FIREWALL_NAME,
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read-posts", "rules": [f"GET {_X_TRACKING_PATH}"]}],
            },
            network_policy={
                "allow": ["read-posts"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[_X_FIREWALL_NAME],
            include_encrypted_secrets=include_encrypted_secrets,
        ),
    )


def _write_model_provider_tracking_registry(
    tmp_path: Path,
    *,
    billable: bool = False,
    vm_fields: dict[str, object] | None = None,
    registry_dir: Path | None = None,
    run_id: str = _DEFAULT_RUN_ID,
    sandbox_marker: str = _DEFAULT_SANDBOX_MARKER,
) -> Path:
    registry_root = registry_dir or tmp_path
    registry_root.mkdir(parents=True, exist_ok=True)
    return _write_registry(
        registry_root,
        vm_info=_single_firewall_vm(
            registry_root,
            run_id=run_id,
            sandbox_marker=sandbox_marker,
            firewall_name=_MODEL_PROVIDER_FIREWALL_NAME,
            api_entry={
                "base": "https://api.anthropic.com",
                "auth": {"headers": {"x-api-key": "test-key"}},
                "permissions": [{"name": "messages", "rules": [f"POST {_MODEL_PROVIDER_PATH}"]}],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[_MODEL_PROVIDER_FIREWALL_NAME] if billable else None,
            vm_fields=vm_fields,
        ),
    )


def _x_tracking_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.x.com",
        path=_X_TRACKING_PATH,
        method="GET",
    )


def _model_provider_tracking_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.anthropic.com",
        path=_MODEL_PROVIDER_PATH,
        method="POST",
    )


def _write_billable_auth_url_rewrite_registry(tmp_path: Path) -> Path:
    return _write_registry(
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


def _auth_url_rewrite_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        path="/",
        method="POST",
        request_body=_AUTH_URL_REWRITE_REQUEST_BODY,
    )


async def test_billable_flow_is_tracked_before_responseheaders(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Drain sees billable requests after request() even before responseheaders()."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=1,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_flow_error_releases_tracking_after_request(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Connection errors release billable tracking created by request()."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

        usage.write_pending_snapshot(flush_request_id="request-1")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )

        flow.error = Error("connection reset")
        mitm_addon.error(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_duplicate_terminal_hooks_do_not_double_decrement_usage_flow(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Duplicate terminal hooks release a tracked flow at most once."""
    reg_path = _write_model_provider_tracking_registry(tmp_path, billable=True)
    first_flow = _model_provider_tracking_flow(real_flow)
    second_flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(first_flow)
        await mitm_addon.request(second_flow)

        usage.write_pending_snapshot(flush_request_id="before-terminal-hooks")
        assert_pending(
            usage_pending_path,
            flows=2,
            buffered=0,
            reports=0,
            flush_request_id="before-terminal-hooks",
        )

        first_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(first_flow)
        usage.write_pending_snapshot(flush_request_id="after-response")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="after-response",
        )

        first_flow.error = Error("connection reset")
        mitm_addon.error(first_flow)
        usage.write_pending_snapshot(flush_request_id="after-duplicate-error")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="after-duplicate-error",
        )

        second_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(second_flow)

    usage.write_pending_snapshot(flush_request_id="after-all-terminal-hooks")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="after-all-terminal-hooks",
    )


async def test_untracked_terminal_hook_does_not_decrement_other_usage_flow(
    tmp_path,
    usage_pending_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """A terminal hook for an untracked flow leaves other tracked flows in flight."""
    billable_reg_path = _write_model_provider_tracking_registry(tmp_path, billable=True)
    non_billable_reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        registry_dir=tmp_path / "non-billable-registry",
    )
    tracked_flow = _model_provider_tracking_flow(real_flow)
    untracked_flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(billable_reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(tracked_flow)
        usage.write_pending_snapshot(flush_request_id="before-untracked-error")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="before-untracked-error",
        )

    with (
        mitm_ctx(registry_path=str(non_billable_reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(untracked_flow)
        assert untracked_flow.metadata["firewall_billable"] is False
        usage.write_pending_snapshot(flush_request_id="after-untracked-request")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="after-untracked-request",
        )

        untracked_flow.error = Error("connection reset")
        mitm_addon.error(untracked_flow)
        usage.write_pending_snapshot(flush_request_id="after-untracked-error")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="after-untracked-error",
        )

    with mitm_ctx(registry_path=str(billable_reg_path), api_url="https://api.vm0.ai"):
        tracked_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(tracked_flow)

    usage.write_pending_snapshot(flush_request_id="after-tracked-response")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="after-tracked-response",
    )


async def test_local_firewall_error_leaves_usage_flows_drained(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Local auth failures do not enqueue usage and must not leak drain counters."""
    reg_path = _write_billable_x_tracking_registry(
        tmp_path,
        include_encrypted_secrets=False,
    )
    flow = _x_tracking_flow(real_flow)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata["firewall_error"] == "auth_unavailable"
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
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    async def return_invalid_auth_after_tracking(*_args, **_kwargs):
        usage.write_pending_snapshot(flush_request_id="during-auth-failure")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="during-auth-failure",
        )
        return {}

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", return_invalid_auth_after_tracking),
        pytest.raises(KeyError),
    ):
        await mitm_addon.request(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_request_cancellation_releases_tracking_during_auth_resolution(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Cancelled auth resolution must not leak request-time usage tracking."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    async def cancel_auth_after_tracking(*_args, **_kwargs):
        usage.write_pending_snapshot(flush_request_id="during-auth-cancel")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="during-auth-cancel",
        )
        raise asyncio.CancelledError

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", cancel_auth_after_tracking),
        pytest.raises(asyncio.CancelledError),
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
):
    """Non-billable model providers without observation metadata are not tracked."""
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        run_id=_MODEL_PROVIDER_RUN_ID,
        sandbox_marker=_MODEL_PROVIDER_SANDBOX_MARKER,
    )
    flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_name"] == _MODEL_PROVIDER_FIREWALL_NAME
    assert flow.metadata["cli_agent_type"] == "claude-code"
    assert flow.metadata["firewall_billable"] is False
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_non_billable_observable_model_provider_is_tracked_before_responseheaders(
    tmp_path, usage_pending_path, real_flow, mitm_ctx, fake_firewall_headers
):
    """BYOK model observations drain during shutdown even without billing."""
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        run_id=_MODEL_PROVIDER_RUN_ID,
        sandbox_marker=_MODEL_PROVIDER_SANDBOX_MARKER,
        vm_fields={"modelUsageProvider": "claude-sonnet-4-6"},
    )
    flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_name"] == _MODEL_PROVIDER_FIREWALL_NAME
    assert flow.metadata["firewall_billable"] is False
    assert flow.metadata["model_usage_provider"] == "claude-sonnet-4-6"
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=1,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_model_provider_records_model_usage_provider(
    tmp_path, usage_pending_path, real_flow, mitm_ctx, fake_firewall_headers
):
    """Registry modelUsageProvider is available to model usage reporting."""
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        billable=True,
        run_id=_MODEL_PROVIDER_RUN_ID,
        sandbox_marker=_MODEL_PROVIDER_SANDBOX_MARKER,
        vm_fields={
            "cliAgentType": "codex",
            "modelUsageProvider": "claude-opus-4-6",
        },
    )
    flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_name"] == _MODEL_PROVIDER_FIREWALL_NAME
    assert flow.metadata["cli_agent_type"] == "codex"
    assert flow.metadata["firewall_billable"] is True
    assert flow.metadata["model_usage_provider"] == "claude-opus-4-6"
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
    reg_path = _write_billable_auth_url_rewrite_registry(tmp_path)
    flow = _auth_url_rewrite_flow(real_flow)
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
        usage.write_pending_snapshot(flush_request_id="request-1")
        assert_pending(
            usage_pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )

        mitm_addon.response(flow)

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
    reg_path = _write_billable_auth_url_rewrite_registry(tmp_path)
    flow = _auth_url_rewrite_flow(real_flow)
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
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(
        usage_pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )


async def test_billable_auth_url_rewrite_forward_cancellation_releases_tracking(
    tmp_path, usage_pending_path, real_flow, mitm_ctx
):
    """Cancelled inline auth.base forwarding drains request-time tracking."""
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
    probe = _ForwardProbe(error=asyncio.CancelledError())

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
            usage.write_pending_snapshot(flush_request_id="during-forward-cancel")
            assert_pending(
                usage_pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="during-forward-cancel",
            )

            probe.release.set()
            with pytest.raises(asyncio.CancelledError):
                await _await_request_task(request_task)
        finally:
            if not request_task.done():
                await _release_forward_probe(probe, request_task)

    assert flow.response is None
    assert "auth_url_rewrite" not in flow.metadata
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
