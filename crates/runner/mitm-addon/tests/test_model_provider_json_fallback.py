"""Tests for model-provider buffered JSON fallback usage reporting."""

import gzip
import json
import zlib

import brotli
import pytest
import zstandard
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import logging_utils
from tests.flow_helpers import header_map
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.model_provider_response_helpers import (
    ANTHROPIC_JSON_CASE,
    CODEX_OAUTH_RESPONSES_CASE,
    JSON_COMPRESSION_FAILURE_CASES,
    MODEL_PROVIDER_JSON_CASES,
    OPENAI_RESPONSES_CASE,
    _expected_event_quantities,
    _expected_usage,
    _json_compression_failure_case_id,
    _model_provider_json_case_id,
    _standard_success_payload,
    model_provider_flow,
    run_response,
    set_common_model_metadata,
)
from tests.stream_buffer_helpers import set_response_stream_buffer


class TestModelProviderJsonFallback:
    """Tests for buffered model-provider JSON fallback extraction."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Non-streaming JSON response should extract usage from buffer."""
        provider_case = ANTHROPIC_JSON_CASE
        flow = model_provider_flow(real_flow, tmp_path, provider_case)
        # No model_provider_usage set (no SSE parser) — JSON body in buffer
        body = _standard_success_payload(provider_case)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        run_response(flow, self._usage_webhook_api)

        # JSON fallback should populate model_provider_usage in metadata
        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected = _expected_usage(provider_case)
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]

    def test_openai_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Legacy JSON fallback should use OpenAI Responses mapping."""
        provider_case = OPENAI_RESPONSES_CASE
        flow = model_provider_flow(real_flow, tmp_path, provider_case)
        body = _standard_success_payload(provider_case)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected = _expected_usage(provider_case)
        assert extracted["message_id"] == expected["message_id"]
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]
        assert extracted["tokens.cache_read"] == expected["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    def test_anthropic_json_fallback_parse_error_logs_proxy_warning(self, tmp_path, real_flow):
        """Legacy JSON fallback parse failures should be observable."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":50'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "incomplete json"

    def test_json_fallback_parser_bound_error_logs_proxy_warning(self, tmp_path, real_flow):
        """Bounded parser failures should be observable without logging body content."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        oversized_model = "x" * 1025
        body = json.dumps(
            {
                "id": "msg_1",
                "model": oversized_model,
                "usage": {"input_tokens": 50},
            }
        ).encode()
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "string limit exceeded"
        assert oversized_model not in read_jsonl_text_after_flush(proxy_log_path)

    def test_openai_json_fallback_parse_error_logs_proxy_warning(self, tmp_path, real_flow):
        """OpenAI fallback parse failures should use the same proxy warning."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "incomplete json"

    @pytest.mark.parametrize(
        "encoding_case",
        JSON_COMPRESSION_FAILURE_CASES,
        ids=_json_compression_failure_case_id,
    )
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_compressed_body_parse_failure_logs_proxy_warning(
        self,
        tmp_path,
        real_flow,
        encoding_case,
        provider_case,
    ):
        """One-shot decompression failures leave compressed bytes and log parse failure."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)
        body = encoding_case.make_body(payload)

        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": encoding_case.content_encoding,
                }
            ),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == encoding_case.expected_error

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_concatenated_zlib_member_reports_usage(
        self,
        tmp_path,
        real_flow,
        encoding_case,
        provider_case,
    ):
        """Zlib stream concatenation should not let an empty first member hide usage."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)
        if encoding_case == "gzip":
            body = gzip.compress(b"") + gzip.compress(payload)
        else:
            body = zlib.compress(b"") + zlib.compress(payload)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": encoding_case,
                }
            ),
        )

        run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected = _expected_usage(provider_case)
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected["tokens.cache_read"]
        if jsonl_exists_after_flush(proxy_log_path):
            entries = read_jsonl_entries_after_flush(proxy_log_path)
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    @pytest.mark.parametrize("encoding_case", ["br", "zstd"])
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_brotli_and_zstd_report_usage(
        self,
        tmp_path,
        real_flow,
        encoding_case,
        provider_case,
    ):
        """Diagnostic fallback should handle complete br/zstd JSON bodies."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)

        if encoding_case == "br":
            body = brotli.compress(payload)
        else:
            body = zstandard.ZstdCompressor().compress(payload)

        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": encoding_case,
                }
            ),
        )

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
        if jsonl_exists_after_flush(proxy_log_path):
            entries = read_jsonl_entries_after_flush(proxy_log_path)
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_json_fallback_valid_body_without_usage_stays_quiet(self, tmp_path, real_flow):
        """Valid JSON without usage is not a parser failure."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1"}'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    def test_openai_json_fallback_valid_body_without_usage_stays_quiet(self, tmp_path, real_flow):
        """OpenAI fallback should also keep valid no-usage JSON quiet."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5"}'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize(
        "encoding_case", ["identity", "gzip", "deflate", "br", "zstd", "zstd-no-size"]
    )
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_empty_body_stays_quiet(
        self,
        tmp_path,
        real_flow,
        encoding_case,
        provider_case,
    ):
        """Empty model-provider bodies are not JSON parser failures."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        if encoding_case == "gzip":
            body = gzip.compress(b"")
        elif encoding_case == "deflate":
            body = zlib.compress(b"")
        elif encoding_case == "br":
            body = brotli.compress(b"")
        elif encoding_case == "zstd":
            body = zstandard.ZstdCompressor().compress(b"")
        elif encoding_case == "zstd-no-size":
            body = zstandard.ZstdCompressor(write_content_size=False).compress(b"")
        else:
            body = b""
        response_headers = {
            "content-type": "application/json",
            "content-length": str(len(body)),
        }
        if encoding_case != "identity":
            response_headers["content-encoding"] = (
                "zstd" if encoding_case == "zstd-no-size" else encoding_case
            )
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(status_code=200, headers=header_map(response_headers))

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    def test_anthropic_json_fallback_metadata_only_usage_stays_quiet(self, tmp_path, real_flow):
        """Anthropic metadata without positive token usage is not a parser failure."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6"}'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "message_id": "msg_1",
            "model": "claude-sonnet-4-6",
        }
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_zero_token_usage_stays_quiet(self, tmp_path, real_flow, provider_case):
        """Valid zero-token usage is not a parser failure and does not bill."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        body = _standard_success_payload(
            provider_case,
            input_tokens=0,
            output_tokens=0,
            cached_tokens=0,
        )
        expected_usage = _expected_usage(
            provider_case,
            input_tokens=0,
            output_tokens=0,
            cached_tokens=0,
        )

        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == expected_usage
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    def test_codex_oauth_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Codex OAuth model-provider fallback uses OpenAI Responses mapping."""
        provider_case = CODEX_OAUTH_RESPONSES_CASE
        flow = model_provider_flow(real_flow, tmp_path, provider_case)
        body = _standard_success_payload(provider_case)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected = _expected_usage(provider_case)
        assert extracted["message_id"] == expected["message_id"]
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]
        assert extracted["tokens.cache_read"] == expected["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    def test_non_billable_openai_json_reports_observation_without_billing(
        self, tmp_path, real_flow
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            billable=False,
        )
        body = _standard_success_payload(OPENAI_RESPONSES_CASE)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.usage_events() == []
        observations = webhook.model_usage_observation_events()
        by_category = {event["category"]: event["quantity"] for event in observations}
        assert by_category == _expected_event_quantities(OPENAI_RESPONSES_CASE)
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"

    def test_non_observable_json_fallback_parse_error_stays_quiet(self, tmp_path, real_flow):
        """Model-provider fallback without MODEL_USAGE_PROVIDER must not emit warnings."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            billable=False,
            observable=False,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    def test_no_usage_report_for_non_model_provider(self, tmp_path, real_flow):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = real_flow(with_response=False, host="api.github.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(proxy_log_path)
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        body = b'{"incomplete":'
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        logging_utils.flush_log_path(str(proxy_log_path))
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_json_fallback_skips_malformed_firewall_name(self, tmp_path, real_flow, firewall_name):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        set_common_model_metadata(flow, tmp_path)
        flow.metadata[metadata_keys.ORIGINAL_URL] = ANTHROPIC_JSON_CASE.original_url
        flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
        body = _standard_success_payload(ANTHROPIC_JSON_CASE)
        set_response_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
