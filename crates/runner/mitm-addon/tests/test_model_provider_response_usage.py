"""Tests for model-provider response usage reporting paths."""

import gzip
import json
import zlib
from pathlib import Path

import pytest
import zstandard
from mitmproxy.test import tutils

import body_utils
import mitm_addon
import usage
from tests.flow_helpers import header_map, response_stream
from tests.usage_helpers import set_stream_buffer


class TestModelProviderResponseUsage:
    """Tests for model-provider JSON usage extraction and response reporting."""

    def test_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Non-streaming JSON response should extract usage from buffer."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No model_provider_usage set (no SSE parser) — JSON body in buffer
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": "Hello"}],
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        with usage_webhook_api():
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        # JSON fallback should populate model_provider_usage in metadata
        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["tokens.input"] == 50
        assert extracted["tokens.output"] == 200

    def test_openai_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Legacy JSON fallback should use OpenAI Responses mapping."""
        flow = real_flow(with_response=False, host="api.openai.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 200,
                    "input_tokens_details": {"cached_tokens": 10},
                },
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["message_id"] == "resp_1"
        assert extracted["model"] == "gpt-5.5"
        assert extracted["tokens.input"] == 40
        assert extracted["tokens.output"] == 200
        assert extracted["tokens.cache_read"] == 10
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 200,
            "tokens.cache_read": 10,
        }

    def test_anthropic_json_fallback_parse_error_logs_proxy_warning(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Legacy JSON fallback parse failures should be observable."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":50'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "incomplete json"

    def test_json_fallback_parser_bound_error_logs_proxy_warning(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Bounded parser failures should be observable without logging body content."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        oversized_model = "x" * 1025
        body = json.dumps(
            {
                "id": "msg_1",
                "model": oversized_model,
                "usage": {"input_tokens": 50},
            }
        ).encode()
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "string limit exceeded"
        assert oversized_model not in proxy_log_path.read_text()

    def test_openai_json_fallback_parse_error_logs_proxy_warning(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """OpenAI fallback parse failures should use the same proxy warning."""
        flow = real_flow(with_response=False, host="api.openai.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "incomplete json"

    @pytest.mark.parametrize(
        "encoding_case",
        [
            "chained-gzip",
            "raw-json-with-unknown-header",
            "raw-deflate",
            "raw-json-with-gzip-header",
            "raw-json-with-br-header",
            "raw-json-with-zstd-header",
            "truncated-gzip-prefix",
            "empty-gzip-member-before-garbage",
            "empty-deflate-stream-before-garbage",
            "truncated-brotli-prefix",
            "truncated-zstd-prefix",
        ],
    )
    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_json_fallback_compressed_body_parse_failure_logs_proxy_warning(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fresh_usage_executor,
        usage_webhook_api,
        encoding_case,
        provider_case,
    ):
        """One-shot decompression failures leave compressed bytes and log parse failure."""
        if provider_case == "openai":
            flow = real_flow(with_response=False, host="api.openai.com")
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
            payload = (
                b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50,"output_tokens":200}}'
            )
        else:
            flow = real_flow(with_response=False, host="api.anthropic.com")
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            payload = (
                b'{"id":"msg_1","model":"claude-sonnet-4-6",'
                b'"usage":{"input_tokens":50,"output_tokens":200}}'
            )
        proxy_log_path = tmp_path / "proxy.jsonl"
        if encoding_case == "chained-gzip":
            body = gzip.compress(payload)
            content_encoding = "gzip, identity"
            expected_error = "unsupported content encoding"
        elif encoding_case == "raw-json-with-unknown-header":
            body = payload
            content_encoding = "x-custom"
            expected_error = "unsupported content encoding"
        elif encoding_case == "raw-json-with-gzip-header":
            body = payload
            content_encoding = "gzip"
            expected_error = "invalid compressed body"
        elif encoding_case == "raw-json-with-br-header":
            body = payload
            content_encoding = "br"
            expected_error = "invalid compressed body"
        elif encoding_case == "raw-json-with-zstd-header":
            body = payload
            content_encoding = "zstd"
            expected_error = "invalid compressed body"
        elif encoding_case == "truncated-gzip-prefix":
            body = gzip.compress(payload)[:10]
            content_encoding = "gzip"
            expected_error = "incomplete compressed body"
        elif encoding_case == "empty-gzip-member-before-garbage":
            body = gzip.compress(b"") + b"garbage"
            content_encoding = "gzip"
            expected_error = "invalid compressed body"
        elif encoding_case == "empty-deflate-stream-before-garbage":
            body = zlib.compress(b"") + b"garbage"
            content_encoding = "deflate"
            expected_error = "invalid compressed body"
        elif encoding_case == "truncated-brotli-prefix":
            body = body_utils.brotli.compress(payload)[:2]
            content_encoding = "br"
            expected_error = "incomplete compressed body"
        elif encoding_case == "truncated-zstd-prefix":
            body = zstandard.ZstdCompressor().compress(payload)[:5]
            content_encoding = "zstd"
            expected_error = "incomplete compressed body"
        else:
            compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
            body = compressor.compress(payload) + compressor.flush()
            content_encoding = "deflate"
            expected_error = "invalid compressed body"

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": content_encoding,
                }
            ),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == expected_error

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_json_fallback_concatenated_zlib_member_reports_usage(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fresh_usage_executor,
        usage_webhook_api,
        encoding_case,
        provider_case,
    ):
        """Zlib stream concatenation should not let an empty first member hide usage."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        if provider_case == "openai":
            flow = real_flow(with_response=False, host="api.openai.com")
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
            payload = (
                b'{"id":"resp_1","model":"gpt-5.5",'
                b'"usage":{"input_tokens":50,"output_tokens":200,'
                b'"input_tokens_details":{"cached_tokens":10}}}'
            )
        else:
            flow = real_flow(with_response=False, host="api.anthropic.com")
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            payload = (
                b'{"id":"msg_1","model":"claude-sonnet-4-6",'
                b'"usage":{"input_tokens":50,"output_tokens":200}}'
            )
        if encoding_case == "gzip":
            body = gzip.compress(b"") + gzip.compress(payload)
        else:
            body = zlib.compress(b"") + zlib.compress(payload)
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": encoding_case,
                }
            ),
        )

        with usage_webhook_api():
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == (
            "gpt-5.5" if provider_case == "openai" else "claude-sonnet-4-6"
        )
        assert extracted["tokens.input"] == (40 if provider_case == "openai" else 50)
        assert extracted["tokens.output"] == 200
        if provider_case == "openai":
            assert extracted["tokens.cache_read"] == 10
        if proxy_log_path.exists():
            entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    @pytest.mark.parametrize("encoding_case", ["br", "zstd"])
    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_json_fallback_brotli_and_zstd_report_usage(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fresh_usage_executor,
        usage_webhook_api,
        encoding_case,
        provider_case,
    ):
        """Diagnostic fallback should handle complete br/zstd JSON bodies."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        if provider_case == "openai":
            flow = real_flow(with_response=False, host="api.openai.com")
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
            payload = json.dumps(
                {
                    "id": "resp_1",
                    "model": "gpt-5.5",
                    "usage": {
                        "input_tokens": 50,
                        "output_tokens": 200,
                        "input_tokens_details": {"cached_tokens": 10},
                    },
                }
            ).encode()
        else:
            flow = real_flow(with_response=False, host="api.anthropic.com")
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            payload = json.dumps(
                {
                    "id": "msg_1",
                    "model": "claude-sonnet-4-6",
                    "usage": {"input_tokens": 50, "output_tokens": 200},
                }
            ).encode()

        if encoding_case == "br":
            body = body_utils.brotli.compress(payload)
        else:
            body = zstandard.ZstdCompressor().compress(payload)

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": encoding_case,
                }
            ),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == (
            "gpt-5.5" if provider_case == "openai" else "claude-sonnet-4-6"
        )
        assert extracted["tokens.input"] == (40 if provider_case == "openai" else 50)
        assert extracted["tokens.output"] == 200
        if provider_case == "openai":
            assert extracted["tokens.cache_read"] == 10
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        expected = {
            "tokens.input": 40 if provider_case == "openai" else 50,
            "tokens.output": 200,
        }
        if provider_case == "openai":
            expected["tokens.cache_read"] = 10
        assert by_category == expected
        if proxy_log_path.exists():
            entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_json_fallback_valid_body_without_usage_stays_quiet(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Valid JSON without usage is not a parser failure."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"msg_1"}'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_openai_json_fallback_valid_body_without_usage_stays_quiet(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """OpenAI fallback should also keep valid no-usage JSON quiet."""
        flow = real_flow(with_response=False, host="api.openai.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"resp_1","model":"gpt-5.5"}'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize(
        "encoding_case", ["identity", "gzip", "deflate", "br", "zstd", "zstd-no-size"]
    )
    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_json_fallback_empty_body_stays_quiet(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fresh_usage_executor,
        usage_webhook_api,
        encoding_case,
        provider_case,
    ):
        """Empty model-provider bodies are not JSON parser failures."""
        if provider_case == "openai":
            flow = real_flow(with_response=False, host="api.openai.com")
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
        else:
            flow = real_flow(with_response=False, host="api.anthropic.com")
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        proxy_log_path = tmp_path / "proxy.jsonl"
        if encoding_case == "gzip":
            body = gzip.compress(b"")
        elif encoding_case == "deflate":
            body = zlib.compress(b"")
        elif encoding_case == "br":
            body = body_utils.brotli.compress(b"")
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
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(status_code=200, headers=header_map(response_headers))

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_anthropic_json_fallback_metadata_only_usage_stays_quiet(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Anthropic metadata without positive token usage is not a parser failure."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6"}'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == {
            "message_id": "msg_1",
            "model": "claude-sonnet-4-6",
        }
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_json_fallback_zero_token_usage_stays_quiet(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api, provider_case
    ):
        """Valid zero-token usage is not a parser failure and does not bill."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        if provider_case == "anthropic":
            flow = real_flow(with_response=False, host="api.anthropic.com")
            body = (
                b'{"id":"msg_1","model":"claude-sonnet-4-6",'
                b'"usage":{"input_tokens":0,"output_tokens":0}}'
            )
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            expected_usage = {
                "message_id": "msg_1",
                "model": "claude-sonnet-4-6",
                "tokens.input": 0,
                "tokens.output": 0,
            }
        else:
            flow = real_flow(with_response=False, host="api.openai.com")
            body = (
                b'{"id":"resp_1","model":"gpt-5.5","usage":'
                b'{"input_tokens":0,"output_tokens":0,'
                b'"input_tokens_details":{"cached_tokens":0}}}'
            )
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
            expected_usage = {
                "message_id": "resp_1",
                "model": "gpt-5.5",
                "tokens.input": 0,
                "tokens.output": 0,
                "tokens.cache_read": 0,
            }

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == expected_usage
        assert not proxy_log_path.exists()

    def test_codex_oauth_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Codex OAuth model-provider fallback uses OpenAI Responses mapping."""
        flow = real_flow(with_response=False, host="chatgpt.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://chatgpt.com/backend-api/codex/responses"
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 200,
                    "input_tokens_details": {"cached_tokens": 10},
                },
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["message_id"] == "resp_1"
        assert extracted["model"] == "gpt-5.5"
        assert extracted["tokens.input"] == 40
        assert extracted["tokens.output"] == 200
        assert extracted["tokens.cache_read"] == 10
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 200,
            "tokens.cache_read": 10,
        }

    def test_non_billable_openai_json_does_not_report_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        flow = real_flow(with_response=False, host="api.openai.com")
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = False
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata

    def test_non_billable_json_fallback_parse_error_stays_quiet(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Non-billable model-provider fallback must not emit usage warnings."""
        flow = real_flow(with_response=False, host="api.openai.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = False
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_full_pipeline_large_model_json_uses_bounded_buffer(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """responseheaders + response report model usage without full-body buffering."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":200}}')
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50, "tokens.output": 200}

    @pytest.mark.parametrize("provider_case", ["anthropic", "openai"])
    def test_full_pipeline_compressed_model_json_reports_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api, provider_case
    ):
        """responseheaders parser should decompress non-SSE model JSON before extraction."""
        if provider_case == "openai":
            flow = real_flow(with_response=False, host="api.openai.com")
            flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
            flow.metadata["firewall_name"] = "model-provider:openai-api-key"
            flow.metadata["cli_agent_type"] = "codex"
            payload = json.dumps(
                {
                    "id": "resp_1",
                    "model": "gpt-5.5",
                    "usage": {
                        "input_tokens": 50,
                        "output_tokens": 200,
                        "input_tokens_details": {"cached_tokens": 10},
                    },
                }
            ).encode()
        else:
            flow = real_flow(with_response=False, host="api.anthropic.com")
            flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            payload = json.dumps(
                {
                    "id": "msg_1",
                    "model": "claude-sonnet-4-6",
                    "usage": {"input_tokens": 50, "output_tokens": 200},
                }
            ).encode()
        compressed = gzip.compress(payload)
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        midpoint = len(compressed) // 2
        response_stream(flow)(compressed[:midpoint])
        response_stream(flow)(compressed[midpoint:])

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == (
            "gpt-5.5" if provider_case == "openai" else "claude-sonnet-4-6"
        )
        assert extracted["tokens.input"] == (40 if provider_case == "openai" else 50)
        assert extracted["tokens.output"] == 200
        if provider_case == "openai":
            assert extracted["tokens.cache_read"] == 10
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        expected = {
            "tokens.input": 40 if provider_case == "openai" else 50,
            "tokens.output": 200,
        }
        if provider_case == "openai":
            expected["tokens.cache_read"] = 10
        assert by_category == expected

    def test_full_pipeline_incomplete_model_json_does_not_report_partial_usage(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Fields seen before EOF are ignored unless the JSON document completes."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50,"output_tokens":200}'
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete json"

    def test_full_pipeline_corrupt_model_json_encoding_does_not_fallback_to_raw_buffer(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """A bad Content-Encoding must not parse raw stream_buffer and bill usage."""
        raw_json = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(raw_json)

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert "stream_buffer" not in flow.metadata

    def test_full_pipeline_model_json_ignores_usage_array_shape(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """usage fields inside array elements must not be treated as usage object fields."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": [{"input_tokens": 50, "output_tokens": 200}],
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body)

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0

    def test_no_usage_report_for_non_model_provider(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = real_flow(with_response=False, host="api.github.com")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.metadata["firewall_name"] = "github"
        body = b'{"incomplete":'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_full_path_response_to_webhook(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Integration: response() -> _maybe_report -> _enqueue -> _retry -> webhook.

        Verifies wiring between all intermediate layers through loopback HTTP.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-001"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 100,
            "tokens.output": 500,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            # Flush the executor to ensure the background POST completes
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        body = webhook.requests[0].json_body()
        assert body["runId"] == "run-int-001"
        by_category = {event["category"]: event for event in body["events"]}
        assert by_category["tokens.input"]["quantity"] == 100
        assert by_category["tokens.output"]["quantity"] == 500
        assert by_category["tokens.input"]["provider"] == "claude-sonnet-4-6"
