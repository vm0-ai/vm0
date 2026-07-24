"""Tests for model-provider WebSocket terminal lifecycle behavior."""

import json
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import mitm_addon
import usage
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_request_flow,
    make_openai_responses_websocket_response_headers,
)
from tests.model_provider_websocket_helpers import feed_websocket_server_message
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.usage_helpers import compact_observation_quantities


def _write_openai_model_websocket_registry(tmp_path: Path) -> Path:
    firewall_name = "model-provider:openai-api-key"
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-abc-123",
            sandbox_marker="tok-xyz",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://api.openai.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "responses", "rules": ["GET /v1/responses"]}],
            },
            network_policy={
                "allow": ["responses"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name],
            vm_fields={
                "cliAgentType": "codex",
                "modelUsageProvider": "gpt-5.5",
            },
        ),
    )


class TestModelProviderWebSocketLifecycle:
    """Tests for HTTP upgrade and terminal in-flight lifecycle behavior."""

    async def test_model_websocket_response_keeps_usage_flow_tracked_until_end(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
        sync_usage_executor,
    ):
        """The HTTP 101 response hook must not complete the WebSocket usage lifecycle."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            usage.write_pending_snapshot(flush_request_id="before-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="before-response",
            )

            flow.response = tutils.tresp(
                status_code=101,
                headers=make_openai_responses_websocket_response_headers(),
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            usage.write_pending_snapshot(flush_request_id="after-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="after-response",
            )

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_1",
                            "model": "gpt-5.5",
                            "usage": {
                                "input_tokens": 50,
                                "output_tokens": 20,
                                "input_tokens_details": {"cached_tokens": 10},
                            },
                        },
                    }
                ).encode(),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        events = usage_webhook_server.usage_events()
        assert len(events) == 3
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }
        observation_events = usage_webhook_server.model_usage_observation_events()
        assert len(observation_events) == 2
        assert compact_observation_quantities(observation_events) == by_category
        assert {event["model"] for event in observation_events} == {"gpt-5.5"}
        usage.write_pending_snapshot(flush_request_id="after-websocket-end")
        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-websocket-end",
        )

    async def test_non_websocket_switching_protocols_response_releases_usage_flow(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
    ):
        """A non-WebSocket 101 response is terminal and must not wait for websocket_end()."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.openai.com",
            path="/v1/responses",
            method="GET",
        )

        with (
            mitm_ctx(registry_path=str(reg_path)),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            usage.write_pending_snapshot(flush_request_id="before-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="before-response",
            )

            flow.response = tutils.tresp(
                status_code=101,
                headers=http.Headers(upgrade="h2c"),
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            usage.write_pending_snapshot(flush_request_id="after-response")

        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-response",
        )

    @pytest.mark.parametrize(
        "response_headers",
        [
            pytest.param(
                make_openai_responses_websocket_response_headers(upgrade="h2c"),
                id="non-websocket-upgrade",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(connection=None),
                id="missing-connection-upgrade",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(accept="wrong"),
                id="wrong-accept",
            ),
        ],
    )
    async def test_invalid_websocket_switching_protocols_response_releases_usage_flow(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        response_headers: http.Headers,
    ):
        """A malformed 101 WebSocket response must not wait for websocket_end()."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path)),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            usage.write_pending_snapshot(flush_request_id="before-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="before-response",
            )

            flow.response = tutils.tresp(status_code=101, headers=response_headers)
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            usage.write_pending_snapshot(flush_request_id="after-response")

        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-response",
        )

    async def test_model_websocket_error_releases_usage_flow_after_upgrade(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
        sync_usage_executor,
    ):
        """A WebSocket connection error after HTTP 101 is terminal for usage tracking."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            flow.response = tutils.tresp(
                status_code=101,
                headers=make_openai_responses_websocket_response_headers(),
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            usage.write_pending_snapshot(flush_request_id="after-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="after-response",
            )

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_error",
                            "model": "gpt-5.5",
                            "usage": {
                                "input_tokens": 10,
                                "output_tokens": 4,
                            },
                        },
                    }
                ).encode(),
            )
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        events = usage_webhook_server.usage_events()
        assert len(events) == 2
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 10,
            "tokens.output": 4,
        }
        observation_events = usage_webhook_server.model_usage_observation_events()
        assert len(observation_events) == len(events)
        assert compact_observation_quantities(observation_events) == by_category
        assert {event["model"] for event in observation_events} == {"gpt-5.5"}
        usage.write_pending_snapshot(flush_request_id="after-error")
        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-error",
        )
