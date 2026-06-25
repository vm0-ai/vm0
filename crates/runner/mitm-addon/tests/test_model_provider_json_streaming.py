"""Tests for model-provider JSON response streaming usage reporting."""

import gzip
import json
import zlib
from pathlib import Path

import brotli
import pytest
import zstandard
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT, STREAM_DECODE_CHUNK_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_response_helpers import (
    ANTHROPIC_JSON_CASE,
    MODEL_PROVIDER_JSON_CASES,
    _expected_event_quantities,
    _expected_usage,
    _model_provider_json_case_id,
    _standard_success_payload,
    model_provider_flow,
    run_response,
)


class TestModelProviderJsonStreaming:
    """Tests for responseheaders-driven model-provider JSON usage extraction."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_non_observable_json_response_does_not_register_incremental_parser(
        self,
        tmp_path,
        real_flow,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            billable=False,
            observable=False,
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(b"x" * (STREAM_BUFFER_LIMIT + 1000))

        assert "model_json_usage_finish" not in flow.metadata
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True

    def test_full_pipeline_large_model_json_uses_bounded_buffer(self, tmp_path, real_flow):
        """responseheaders + response report model usage without full-body buffering."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":200}}')
        assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        assert extracted["message_id"] == "msg_1"
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["tokens.input"] == 50
        assert extracted["tokens.output"] == 200
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50, "tokens.output": 200}

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_full_pipeline_compressed_model_json_reports_usage(
        self, tmp_path, real_flow, provider_case
    ):
        """responseheaders parser should decompress non-SSE model JSON before extraction."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = _standard_success_payload(provider_case)
        compressed = gzip.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        midpoint = len(compressed) // 2
        response_stream(flow)(compressed[:midpoint])
        response_stream(flow)(compressed[midpoint:])

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = _expected_usage(provider_case)
        assert extracted["message_id"] == expected_usage["message_id"]
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    def test_full_pipeline_zstd_model_json_scans_past_decode_chunk_limit(
        self,
        tmp_path,
        real_flow,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = (
            b'{"id":"msg_zstd","model":"claude-sonnet-4-6","content":[{"text":"'
            + b"A" * (STREAM_DECODE_CHUNK_LIMIT * 3)
            + b'"}],"usage":{"input_tokens":10,"output_tokens":20}}'
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "zstd"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(zstandard.ZstdCompressor().compress(payload))

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        assert extracted["message_id"] == "msg_zstd"
        assert extracted["tokens.input"] == 10
        assert extracted["tokens.output"] == 20
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 10, "tokens.output": 20}

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_full_pipeline_truncated_compressed_model_json_does_not_report_usage(
        self, tmp_path, real_flow, encoding_case, provider_case
    ):
        """Incremental JSON usage must reject compressed streams missing a trailer."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)
        if encoding_case == "gzip":
            compressed = gzip.compress(payload)[:-1]
        else:
            compressed = zlib.compress(payload)[:-1]
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete compressed body"

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_concatenated_zlib_model_json_reports_usage(
        self, tmp_path, real_flow, encoding_case
    ):
        """Streaming decompression should feed later zlib members into JSON usage parsing."""
        provider_case = ANTHROPIC_JSON_CASE
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = _standard_success_payload(provider_case)
        if encoding_case == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(payload)
        else:
            compressed = zlib.compress(b"") + zlib.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = _expected_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_full_pipeline_brotli_model_json_uses_bounded_fallback(
        self, tmp_path, real_flow, provider_case
    ):
        """Brotli streaming decode is skipped, but bounded JSON fallback remains active."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = _standard_success_payload(provider_case)
        compressed = brotli.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = _expected_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    def test_full_pipeline_incomplete_model_json_does_not_report_partial_usage(
        self, tmp_path, real_flow
    ):
        """Fields seen before EOF are ignored unless the JSON document completes."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50,"output_tokens":200}'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete json"

    def test_full_pipeline_corrupt_model_json_encoding_does_not_fallback_to_raw_buffer(
        self, tmp_path, real_flow
    ):
        """A bad Content-Encoding must not parse raw stream_buffer and bill usage."""
        raw_json = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(raw_json)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

    def test_full_pipeline_model_json_ignores_usage_array_shape(self, tmp_path, real_flow):
        """usage fields inside array elements must not be treated as usage object fields."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": [{"input_tokens": 50, "output_tokens": 200}],
            }
        ).encode()
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
