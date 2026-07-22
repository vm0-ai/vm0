"""Tests for model-provider WebSocket usage reporting paths."""

import json
import uuid
from pathlib import Path
from typing import Literal

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
)
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
    feed_websocket_server_text_message,
    openai_websocket_usage_frame,
    set_websocket_message,
)


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _assert_usage_event_rows(
    events: list[dict],
    resource_field: Literal["provider", "model"],
    expected_rows: list[tuple[str, str, int]],
) -> None:
    actual_rows = [
        (event[resource_field], event["category"], event["quantity"]) for event in events
    ]
    assert len(events) == len(expected_rows)
    assert sorted(actual_rows) == sorted(expected_rows)

    idempotency_keys = [event["idempotencyKey"] for event in events]
    assert len(set(idempotency_keys)) == len(idempotency_keys)
    for key in idempotency_keys:
        uuid.UUID(key)


def _openai_websocket_zero_usage_frame(response_id: str, *, model: str | None = "gpt-5.5") -> bytes:
    response: dict = {
        "id": response_id,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }
    if model is not None:
        response["model"] = model
    return json.dumps(
        {
            "type": "response.completed",
            "response": response,
        }
    ).encode()


class TestModelProviderWebSocketUsageSourceRelease:
    """Tests for sources that cannot be delivered to the usage webhook."""

    def test_model_websocket_missing_context_releases_positive_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = ""
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])

        with mitm_ctx(api_url="https://api.vm0.ai"):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_missing_context",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        entries = read_jsonl_entries_after_flush(proxy_log)
        [entry] = [entry for entry in entries if entry.get("type") == "usage_underbilling"]
        [observation_entry] = [
            entry for entry in entries if entry.get("type") == "model_usage_observation"
        ]
        assert entry["type"] == "usage_underbilling"
        assert entry["reason"] == "missing_reporting_context"
        assert entry["underbilling_class"] == "confirmed"
        assert entry["run_id"] == "run-abc-123"
        assert entry["firewall_name"] == "model-provider:openai-api-key"
        assert entry["missing_sandbox_token"] is True
        assert entry["missing_api_url"] is False
        assert observation_entry["level"] == "warn"
        assert (
            observation_entry["message"]
            == "Cannot report model usage observation: missing sandbox_token or api_url"
        )

    def test_model_websocket_missing_api_url_releases_positive_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])

        with mitm_ctx(api_url=""):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_missing_api_url",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        [entry] = [
            entry
            for entry in read_jsonl_entries_after_flush(proxy_log)
            if entry.get("type") == "usage_underbilling"
        ]
        assert entry["reason"] == "missing_reporting_context"
        assert entry["missing_sandbox_token"] is False
        assert entry["missing_api_url"] is True

    def test_model_websocket_missing_context_releases_zero_only_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = ""
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])

        feed_websocket_server_message(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_zero_missing_context",
                input_tokens=0,
                output_tokens=0,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        assert not jsonl_exists_after_flush(proxy_log)

    def test_model_websocket_missing_api_url_releases_zero_only_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])

        with mitm_ctx(api_url=""):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_zero_missing_api_url",
                    input_tokens=0,
                    output_tokens=0,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        assert not jsonl_exists_after_flush(proxy_log)


class TestModelProviderWebSocketUsage:
    """Tests for model-provider WebSocket usage reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_websocket_messages_and_end(self, flow: http.HTTPFlow, *messages: bytes):
        with self._usage_webhook_api() as webhook:
            for message in messages:
                feed_websocket_server_message(flow, message)
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
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        assert flow.metadata["model_websocket_usage_enabled"] is True
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        set_websocket_message(
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
                            "input_tokens_details": {
                                "cached_tokens": 10,
                                "cache_write_tokens": 15,
                            },
                        },
                    },
                }
            ).encode(),
        )

        webhook = self._run_websocket_message_and_end(flow)

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
        _assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 25),
                ("gpt-5.5", "tokens.output", 20),
                ("gpt-5.5", "tokens.cache_read", 10),
                ("gpt-5.5", "tokens.cache_creation", 15),
            ],
        )

    def test_full_pipeline_model_websocket_reports_multiple_response_ids(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
            ),
            openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_late_same_id_frame_after_release_is_duplicate(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=20,
                output_tokens=12,
            ),
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=7,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_late_same_id_frame_can_add_new_category_after_release(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 20},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_late_same_id_snapshot_does_not_mix_input_partition(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_partition",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 20},
                        },
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_partition",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "input_tokens_details": {
                                "cached_tokens": 20,
                                "cache_write_tokens": 30,
                            },
                        },
                    },
                }
            ).encode(),
        )

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category) == 3
        assert len({event["idempotencyKey"] for event in events}) == 3
        assert by_category == {
            "tokens.input": 80,
            "tokens.output": 40,
            "tokens.cache_read": 20,
        }
        observation_events = webhook.model_usage_observation_events()
        observations_by_category = {
            event["category"]: event["quantity"] for event in observation_events
        }
        assert len(observation_events) == len(observations_by_category) == 3
        assert len({event["idempotencyKey"] for event in observation_events}) == 3
        assert observations_by_category == by_category
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frame_model_is_used_by_later_positive_frame(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0, "output_tokens": 0},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "usage": {"input_tokens": 20, "output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_zero_frame_without_model_releases_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                _openai_websocket_zero_usage_frame("resp_ws_zero_no_model", model=None),
            )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frame_with_flow_model_releases_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-flow-model"
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                _openai_websocket_zero_usage_frame(
                    "resp_ws_zero_flow_model", model="gpt-frame-model"
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frames_are_bounded(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for index in range(70):
                feed_websocket_server_message(
                    flow,
                    _openai_websocket_zero_usage_frame(
                        f"resp_ws_zero_{index}", model=f"gpt-zero-{index}"
                    ),
                )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        usage_sources = model_provider_usage_sources(flow)
        assert usage_sources == {}

    def test_model_websocket_flow_model_reports_later_positive_usage_without_zero_hint(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for index in range(70):
                feed_websocket_server_message(
                    flow,
                    _openai_websocket_zero_usage_frame(
                        f"resp_ws_zero_{index}", model=f"gpt-zero-{index}"
                    ),
                )

            assert "resp_ws_zero_0" not in model_provider_usage_sources(flow)

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.done",
                        "response": {
                            "id": "resp_ws_zero_0",
                            "usage": {"input_tokens": 20, "output_tokens": 12},
                        },
                    }
                ).encode(),
            )
            usage.flush_usage_events(trigger="test")

        usage_sources = model_provider_usage_sources(flow)
        assert "resp_ws_zero_0" not in usage_sources
        assert usage_sources == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_text_frame_reports_usage(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_text_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_text",
                            "model": "gpt-5.4",
                            "usage": {"input_tokens": 3, "output_tokens": 2},
                        },
                    }
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_valid_frame_replaces_invalid_usage_sources_metadata(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = "invalid"

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_invalid_sources",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert model_provider_usage_sources(flow) == {}
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_model_websocket_same_id_zero_after_positive_does_not_double_bill(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=20,
                output_tokens=12,
            ),
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=0,
                output_tokens=0,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_full_pipeline_model_websocket_uses_context_model_for_response_ids(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
            openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
                model="gpt-5.4",
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    def test_full_pipeline_model_websocket_reports_id_and_missing_id_usage(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
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
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
        )

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "model": "gpt-5.5",
            "tokens.input": 7,
            "tokens.output": 1,
        }
        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 7),
            ("gpt-5.5", "tokens.output", 1),
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
        ]
        _assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        _assert_usage_event_rows(webhook.model_usage_observation_events(), "model", expected_rows)

    @pytest.mark.parametrize(
        "later_cache_write_tokens",
        [0, None],
        ids=["zero", "omitted"],
    )
    def test_model_websocket_missing_id_raw_snapshots_preserve_input_partition(
        self,
        tmp_path,
        real_flow,
        later_cache_write_tokens,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        later_input_details = {"cached_tokens": 20}
        if later_cache_write_tokens is not None:
            later_input_details["cache_write_tokens"] = later_cache_write_tokens

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "input_tokens_details": {
                                "cached_tokens": 20,
                                "cache_write_tokens": 30,
                            },
                        },
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "input_tokens_details": later_input_details,
                        },
                    },
                }
            ).encode(),
        )

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category) == 4
        assert by_category == {
            "tokens.input": 50,
            "tokens.output": 40,
            "tokens.cache_read": 20,
            "tokens.cache_creation": 30,
        }
        assert (
            by_category["tokens.input"]
            + by_category["tokens.cache_read"]
            + by_category["tokens.cache_creation"]
            == 100
        )
        observation_events = webhook.model_usage_observation_events()
        observations_by_category = {
            event["category"]: event["quantity"] for event in observation_events
        }
        assert len(observation_events) == len(observations_by_category) == 4
        assert observations_by_category == by_category
        assert model_provider_usage_sources(flow) == {}

    def test_full_pipeline_model_websocket_zero_frame_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
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

        assert model_provider_usage_sources(flow) == {}
        _assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 100),
                ("gpt-5.5", "tokens.output", 40),
            ],
        )

    def test_model_websocket_ignores_client_messages(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        set_websocket_message(
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
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
