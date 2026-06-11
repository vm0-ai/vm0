"""Tests for model-provider WebSocket usage reporting paths."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import mitm_addon
import usage
from tests.model_provider_websocket_helpers import (
    _append_websocket_message,
    _capture_deferred_websocket_trims,
    _feed_websocket_server_message,
    _model_websocket_usage_sources,
    _openai_model_websocket_flow,
    _openai_websocket_usage_frame,
    _run_deferred_websocket_trims,
    _ScheduledWebSocketTrim,
    _set_websocket_message,
)
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_vm, _write_registry


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[_ScheduledWebSocketTrim]:
    return _capture_deferred_websocket_trims(monkeypatch)


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
                "permissions": [{"name": "responses", "rules": ["POST /v1/responses"]}],
            },
            network_policy={
                "allow": ["responses"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name],
            vm_fields={"cliAgentType": "codex"},
        ),
    )


def _openai_model_websocket_request_flow(
    real_flow: Callable[..., http.HTTPFlow],
) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openai.com",
        path="/v1/responses",
        method="POST",
    )


class TestModelProviderWebSocketUsage:
    """Tests for model-provider WebSocket usage reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_response(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_error(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_websocket_end(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_websocket_message_and_end(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def test_full_pipeline_model_websocket_reports_usage(self, tmp_path, real_flow):
        """Codex Responses WebSocket frames should bill like SSE events."""
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        assert flow.metadata["model_websocket_usage_enabled"] is True
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

        _set_websocket_message(
            flow,
            from_client=False,
            content=json.dumps(
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

        webhook = self._run_websocket_message_and_end(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert flow.metadata["model_provider_usage"] == {}
        assert _model_websocket_usage_sources(flow)["resp_ws_1"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }

    def test_full_pipeline_model_websocket_reports_multiple_response_ids(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            _openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
            ),
        )
        _feed_websocket_server_message(
            flow,
            _openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
            ),
        )

        webhook = self._run_websocket_end(flow)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 13,
            "tokens.output": 6,
        }
        assert {
            event["category"]: event["quantity"]
            for event in webhook.model_usage_observation_events()
        } == {
            "tokens.input": 13,
            "tokens.output": 6,
        }

    def test_full_pipeline_model_websocket_separates_response_id_models(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            _openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
        )
        _feed_websocket_server_message(
            flow,
            _openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
                model="gpt-5.4",
            ),
        )

        webhook = self._run_websocket_end(flow)

        assert {
            (event["provider"], event["category"]): event["quantity"]
            for event in webhook.usage_events()
        } == {
            ("gpt-5.5", "tokens.input"): 10,
            ("gpt-5.5", "tokens.output"): 4,
            ("gpt-5.4", "tokens.input"): 3,
            ("gpt-5.4", "tokens.output"): 2,
        }
        assert {
            (event["model"], event["category"]): event["quantity"]
            for event in webhook.model_usage_observation_events()
        } == {
            ("gpt-5.5", "tokens.input"): 10,
            ("gpt-5.5", "tokens.output"): 4,
            ("gpt-5.4", "tokens.input"): 3,
            ("gpt-5.4", "tokens.output"): 2,
        }

    def test_full_pipeline_model_websocket_reports_id_and_missing_id_usage(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 7, "output_tokens": 1},
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            _openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
        )

        webhook = self._run_websocket_end(flow)

        assert flow.metadata["model_provider_usage"] == {
            "model": "gpt-5.5",
            "tokens.input": 7,
            "tokens.output": 1,
        }
        assert _model_websocket_usage_sources(flow)["resp_ws_1"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }
        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 17,
            "tokens.output": 5,
        }
        assert {
            event["category"]: event["quantity"]
            for event in webhook.model_usage_observation_events()
        } == {
            "tokens.input": 17,
            "tokens.output": 5,
        }

    async def test_model_websocket_response_keeps_usage_flow_tracked_until_end(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
    ):
        """The HTTP 101 response hook must not complete the WebSocket usage lifecycle."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = _openai_model_websocket_request_flow(real_flow)

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
                headers=http.Headers(upgrade="websocket"),
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

            _feed_websocket_server_message(
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
        assert len(observation_events) == len(events)
        assert {event["category"]: event["quantity"] for event in observation_events} == by_category
        assert {event["model"] for event in observation_events} == {"gpt-5.5"}
        usage.write_pending_snapshot(flush_request_id="after-websocket-end")
        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-websocket-end",
        )

    async def test_model_websocket_error_releases_usage_flow_after_upgrade(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
    ):
        """A WebSocket connection error after HTTP 101 is terminal for usage tracking."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = _openai_model_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            flow.response = tutils.tresp(
                status_code=101,
                headers=http.Headers(upgrade="websocket"),
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

            _feed_websocket_server_message(
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
        assert {event["category"]: event["quantity"] for event in observation_events} == by_category
        assert {event["model"] for event in observation_events} == {"gpt-5.5"}
        usage.write_pending_snapshot(flush_request_id="after-error")
        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-error",
        )

    def test_full_pipeline_model_websocket_zero_frame_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_empty",
                        "model": "gpt-5.4",
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            ).encode(),
        )

        webhook = self._run_websocket_end(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert set(idempotency_by_category) == {"tokens.input", "tokens.output"}
        for key in idempotency_by_category.values():
            uuid.UUID(key)
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_model_websocket_ignores_client_messages(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        _set_websocket_message(
            flow,
            from_client=True,
            content=json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 50, "output_tokens": 20},
                    },
                }
            ).encode(),
        )

        webhook = self._run_websocket_message_and_end(flow)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == {}
        assert _model_websocket_usage_sources(flow) == {}

    def test_model_websocket_deferred_trim_keeps_latest_server_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        old_client = _append_websocket_message(flow, from_client=True, content=b"client-old")
        old_server = _append_websocket_message(flow, from_client=False, content=b"server-old")
        latest_server = _append_websocket_message(
            flow,
            from_client=False,
            content=_openai_websocket_usage_frame("resp_ws_latest"),
        )
        assert flow.websocket is not None
        messages = flow.websocket.messages

        mitm_addon.websocket_message(flow)

        assert messages == [old_client, old_server, latest_server]
        assert _model_websocket_usage_sources(flow) == {
            "resp_ws_latest": {
                "message_id": "resp_ws_latest",
                "model": "gpt-5.5",
                "tokens.input": 10,
                "tokens.output": 4,
            }
        }
        assert flow.metadata["model_provider_usage"] == {}
        assert len(deferred_websocket_trim_scheduler) == 1

        _run_deferred_websocket_trims(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages is messages
        assert flow.websocket.messages == [latest_server]

    def test_model_websocket_deferred_trim_keeps_latest_client_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        old_server = _append_websocket_message(flow, from_client=False, content=b"server-old")
        latest_client = _append_websocket_message(
            flow,
            from_client=True,
            content=_openai_websocket_usage_frame("resp_ws_client"),
        )

        mitm_addon.websocket_message(flow)

        assert flow.metadata["model_provider_usage"] == {}
        assert _model_websocket_usage_sources(flow) == {}
        assert len(deferred_websocket_trim_scheduler) == 1

        _run_deferred_websocket_trims(deferred_websocket_trim_scheduler)

        assert flow.websocket is not None
        assert flow.websocket.messages == [latest_client]
        assert old_server not in flow.websocket.messages

    def test_model_websocket_deferred_trim_coalesces_and_keeps_latest_at_callback(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        first_server = _append_websocket_message(
            flow,
            from_client=False,
            content=_openai_websocket_usage_frame(
                "resp_ws_first",
                input_tokens=1,
                output_tokens=1,
            ),
        )
        mitm_addon.websocket_message(flow)
        assert len(deferred_websocket_trim_scheduler) == 1

        latest_server = _append_websocket_message(
            flow,
            from_client=False,
            content=_openai_websocket_usage_frame("resp_ws_latest"),
        )
        mitm_addon.websocket_message(flow)

        assert len(deferred_websocket_trim_scheduler) == 1
        assert flow.websocket is not None
        assert flow.websocket.messages == [first_server, latest_server]

        _run_deferred_websocket_trims(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages == [latest_server]
        assert _model_websocket_usage_sources(flow) == {
            "resp_ws_first": {
                "message_id": "resp_ws_first",
                "model": "gpt-5.5",
                "tokens.input": 1,
                "tokens.output": 1,
            },
            "resp_ws_latest": {
                "message_id": "resp_ws_latest",
                "model": "gpt-5.5",
                "tokens.input": 10,
                "tokens.output": 4,
            },
        }
        assert flow.metadata["model_provider_usage"] == {}

    def test_non_model_websocket_message_retention_is_unchanged(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = real_flow(with_response=False, host="example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        first = _append_websocket_message(flow, from_client=True, content=b"client")
        second = _append_websocket_message(flow, from_client=False, content=b"server")

        mitm_addon.websocket_message(flow)

        assert deferred_websocket_trim_scheduler == []
        assert flow.websocket is not None
        assert flow.websocket.messages == [first, second]

    def test_model_websocket_end_clears_final_retained_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        _append_websocket_message(
            flow,
            from_client=False,
            content=_openai_websocket_usage_frame("resp_ws_1"),
        )
        mitm_addon.websocket_message(flow)
        assert len(deferred_websocket_trim_scheduler) == 1

        webhook = self._run_websocket_end(flow)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 10,
            "tokens.output": 4,
        }
        assert flow.websocket is not None
        assert flow.websocket.messages == []

        _run_deferred_websocket_trims(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []

    def test_model_websocket_error_clears_final_retained_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[_ScheduledWebSocketTrim],
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.error = Error("connection reset by peer")
        _append_websocket_message(
            flow,
            from_client=False,
            content=_openai_websocket_usage_frame("resp_ws_1"),
        )
        mitm_addon.websocket_message(flow)
        assert len(deferred_websocket_trim_scheduler) == 1

        webhook = self._run_error(flow)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 10,
            "tokens.output": 4,
        }
        assert flow.websocket is not None
        assert flow.websocket.messages == []

        _run_deferred_websocket_trims(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []
