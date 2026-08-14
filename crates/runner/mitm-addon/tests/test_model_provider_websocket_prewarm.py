"""Tests for model-provider WebSocket prewarm usage correlation."""

import json
from pathlib import Path

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
    model_usage_source_entries,
)
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_client_message,
    feed_websocket_server_message,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _openai_websocket_created_frame(response_id: str) -> bytes:
    return json.dumps(
        {
            "type": "response.created",
            "response": {"id": response_id},
        }
    ).encode()


class TestModelProviderWebSocketPrewarmUsage:
    """Tests for exact non-generating response source exclusion."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_model_websocket_ignores_bound_prewarm_and_reports_normal_input_only_turn(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        sensitive_marker = "prewarm-sensitive-marker"
        prewarm_request = json.dumps(
            {
                "type": "response.create",
                "input": [{"role": "user", "content": sensitive_marker * 300}],
                "tools": [{"name": "test-tool", "description": "x" * 5000}],
                "generate": False,
            }
        ).encode()

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, prewarm_request)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-1"))
            prewarm_usage = openai_websocket_usage_frame(
                "warm-1",
                input_tokens=6050,
                output_tokens=0,
            )
            feed_websocket_server_message(flow, prewarm_usage)

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "input": []}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-1",
                    input_tokens=10,
                    output_tokens=0,
                ),
            )
            feed_websocket_server_message(flow, prewarm_usage)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 10)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )
        ignored_entries = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        [ignored_entry] = ignored_entries
        assert ignored_entry["reason"] == "responses_generate_false"
        assert ignored_entry["provider_response_id"] == "warm-1"
        assert ignored_entry["source_id"] == f"{flow.id}:warm-1"
        assert ignored_entry["usage"] == {"tokens.input": 6050}
        assert ignored_entry["usage_events"] == []
        assert ignored_entry["model_usage_observations"] == []
        assert ignored_entry["url"] == "https://api.openai.com/v1/responses"
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])
        assert sensitive_marker not in proxy_log.read_text()
        assert model_provider_usage_sources(flow) == {}
        assert response_streaming.is_model_websocket_usage_enabled(flow) is False
        assert "_model_websocket_prewarm_state" not in flow.metadata

    def test_model_websocket_unbound_prewarm_usage_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "warm-without-created",
                    input_tokens=12,
                    output_tokens=0,
                ),
            )
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("response-after-unbound-terminal"),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "response-after-unbound-terminal",
                    input_tokens=4,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [
            ("gpt-5.5", "tokens.input", 12),
            ("gpt-5.5", "tokens.input", 4),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )

    def test_model_websocket_prewarm_with_missing_created_id_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                json.dumps({"type": "response.created", "response": {}}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "unbound-response",
                    input_tokens=6,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 6)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )

    @pytest.mark.parametrize(
        "client_request",
        [
            b'{"type":"response.create"}',
            b'{"type":"response.create","generate":true}',
            b'{"type":"response.create","generate":"false"}',
            b'{"type":"response.create","generate":true,"generate":false}',
            b'{"type":"other","type":"response.create","generate":false}',
        ],
    )
    def test_model_websocket_non_prewarm_requests_retain_input_only_usage(
        self,
        tmp_path,
        real_flow,
        client_request: bytes,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, client_request)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-input-only"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-input-only",
                    input_tokens=9,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 9)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )

    def test_model_websocket_conflicting_created_ids_fail_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                b'{"type":"response.created","response":{"id":"first","id":"second"}}',
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "second",
                    input_tokens=11,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 11)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )

    def test_model_websocket_conflicting_terminal_ids_fail_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("warm-ambiguous"),
            )
            feed_websocket_server_message(
                flow,
                b'{"type":"response.completed","response":'
                b'{"id":"other","id":"warm-ambiguous","model":"gpt-5.5",'
                b'"usage":{"input_tokens":13,"output_tokens":0}}}',
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 13)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )

    def test_model_websocket_malformed_client_frame_retires_unbound_prewarm(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_client_message(flow, b'{"type":"response.create"')
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-after-bad"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-after-bad",
                    input_tokens=8,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 8)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )

    def test_model_websocket_prewarm_state_isolated_by_flow(self, tmp_path, real_flow):
        prewarm_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        normal_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(prewarm_flow)
        mitm_addon.responseheaders(normal_flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                prewarm_flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                prewarm_flow,
                _openai_websocket_created_frame("shared-response-id"),
            )
            feed_websocket_server_message(
                prewarm_flow,
                openai_websocket_usage_frame(
                    "shared-response-id",
                    input_tokens=5,
                    output_tokens=0,
                ),
            )

            feed_websocket_client_message(
                normal_flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(
                normal_flow,
                _openai_websocket_created_frame("shared-response-id"),
            )
            feed_websocket_server_message(
                normal_flow,
                openai_websocket_usage_frame(
                    "shared-response-id",
                    input_tokens=7,
                    output_tokens=0,
                ),
            )
            feed_websocket_client_message(
                normal_flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                normal_flow,
                _openai_websocket_created_frame("second-prewarm"),
            )
            feed_websocket_server_message(
                normal_flow,
                openai_websocket_usage_frame(
                    "second-prewarm",
                    input_tokens=6,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 7)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert_usage_event_rows(
            webhook.model_usage_observation_events(),
            "model",
            expected_rows,
        )
        ignored_entries = [
            entry
            for entry in model_usage_source_entries(prewarm_flow)
            if entry.get("disposition") == "ignored"
        ]
        assert {
            (entry["flow_id"], entry["provider_response_id"], entry["usage"]["tokens.input"])
            for entry in ignored_entries
        } == {
            (prewarm_flow.id, "shared-response-id", 5),
            (normal_flow.id, "second-prewarm", 6),
        }
