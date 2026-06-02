"""Tests for model-provider response usage reporting paths."""

import gzip
import json
import zlib
from dataclasses import dataclass
from pathlib import Path

import pytest
import zstandard
from mitmproxy.test import tutils

import body_utils
import mitm_addon
import usage
from tests.flow_helpers import header_map, response_stream
from tests.usage_helpers import set_stream_buffer


@dataclass(frozen=True)
class ModelProviderJsonCase:
    id: str
    host: str
    original_url: str
    firewall_name: str
    cli_agent_type: str | None
    message_id: str
    model: str
    uses_openai_responses: bool
    input_tokens: int = 50
    output_tokens: int = 200
    cached_tokens: int | None = None


ANTHROPIC_JSON_CASE = ModelProviderJsonCase(
    id="anthropic",
    host="api.anthropic.com",
    original_url="https://api.anthropic.com/v1/messages",
    firewall_name="model-provider:anthropic-api-key",
    cli_agent_type=None,
    message_id="msg_1",
    model="claude-sonnet-4-6",
    uses_openai_responses=False,
)

OPENAI_RESPONSES_CASE = ModelProviderJsonCase(
    id="openai",
    host="api.openai.com",
    original_url="https://api.openai.com/v1/responses",
    firewall_name="model-provider:openai-api-key",
    cli_agent_type="codex",
    message_id="resp_1",
    model="gpt-5.5",
    uses_openai_responses=True,
    cached_tokens=10,
)

CODEX_OAUTH_RESPONSES_CASE = ModelProviderJsonCase(
    id="codex-oauth",
    host="chatgpt.com",
    original_url="https://chatgpt.com/backend-api/codex/responses",
    firewall_name="model-provider:codex-oauth-token",
    cli_agent_type="codex",
    message_id="resp_1",
    model="gpt-5.5",
    uses_openai_responses=True,
    cached_tokens=10,
)

MODEL_PROVIDER_JSON_CASES = (ANTHROPIC_JSON_CASE, OPENAI_RESPONSES_CASE)


def _model_provider_json_case_id(provider_case: ModelProviderJsonCase) -> str:
    return provider_case.id


def _standard_success_payload(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
) -> bytes:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    usage_payload: dict[str, object] = {
        "input_tokens": resolved_input_tokens,
        "output_tokens": resolved_output_tokens,
    }
    if provider_case.uses_openai_responses and resolved_cached_tokens is not None:
        usage_payload["input_tokens_details"] = {
            "cached_tokens": resolved_cached_tokens,
        }
    payload: dict[str, object] = {
        "id": provider_case.message_id,
        "model": provider_case.model,
        "usage": usage_payload,
    }
    if not provider_case.uses_openai_responses:
        payload["content"] = [{"type": "text", "text": "Hello"}]
    return json.dumps(payload).encode()


def _expected_usage(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
) -> dict[str, object]:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    expected = {
        "message_id": provider_case.message_id,
        "model": provider_case.model,
        "tokens.input": resolved_input_tokens,
        "tokens.output": resolved_output_tokens,
    }
    if provider_case.uses_openai_responses and resolved_cached_tokens is not None:
        assert resolved_cached_tokens <= resolved_input_tokens
        expected["tokens.input"] = resolved_input_tokens - resolved_cached_tokens
        expected["tokens.cache_read"] = resolved_cached_tokens
    return expected


def _expected_event_quantities(provider_case: ModelProviderJsonCase) -> dict[str, int]:
    return {
        category: quantity
        for category, quantity in _expected_usage(provider_case).items()
        if category.startswith("tokens.")
        and isinstance(quantity, int)
        and not isinstance(quantity, bool)
        and quantity > 0
    }


class TestModelProviderResponseUsage:
    """Tests for model-provider JSON usage extraction and response reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_response(self, flow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _set_common_model_metadata(
        self,
        flow,
        tmp_path: Path,
        *,
        billable: bool = True,
        client_ip: str | None = "10.200.0.1",
        proxy_log_path: Path | None = None,
        run_id: str = "run-abc-123",
    ) -> None:
        flow.metadata["vm_run_id"] = run_id
        if client_ip is not None:
            flow.metadata["vm_client_ip"] = client_ip
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        if proxy_log_path is not None:
            flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_billable"] = billable
        flow.metadata["vm_sandbox_token"] = "tok-xyz"

    def _set_model_provider_metadata(
        self,
        flow,
        tmp_path: Path,
        provider_case: ModelProviderJsonCase,
        *,
        billable: bool = True,
        client_ip: str | None = "10.200.0.1",
        proxy_log_path: Path | None = None,
        run_id: str = "run-abc-123",
    ) -> None:
        self._set_common_model_metadata(
            flow,
            tmp_path,
            billable=billable,
            client_ip=client_ip,
            proxy_log_path=proxy_log_path,
            run_id=run_id,
        )
        flow.metadata["original_url"] = provider_case.original_url
        flow.metadata["firewall_name"] = provider_case.firewall_name
        if provider_case.cli_agent_type is not None:
            flow.metadata["cli_agent_type"] = provider_case.cli_agent_type

    def _model_provider_flow(
        self,
        real_flow,
        tmp_path: Path,
        provider_case: ModelProviderJsonCase,
        *,
        billable: bool = True,
        client_ip: str | None = "10.200.0.1",
        proxy_log_path: Path | None = None,
        run_id: str = "run-abc-123",
    ):
        flow = real_flow(with_response=False, host=provider_case.host)
        self._set_model_provider_metadata(
            flow,
            tmp_path,
            provider_case,
            billable=billable,
            client_ip=client_ip,
            proxy_log_path=proxy_log_path,
            run_id=run_id,
        )
        return flow

    def test_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Non-streaming JSON response should extract usage from buffer."""
        provider_case = ANTHROPIC_JSON_CASE
        flow = self._model_provider_flow(real_flow, tmp_path, provider_case)
        # No model_provider_usage set (no SSE parser) — JSON body in buffer
        body = _standard_success_payload(provider_case)
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        self._run_response(flow)

        # JSON fallback should populate model_provider_usage in metadata
        extracted = flow.metadata["model_provider_usage"]
        expected = _expected_usage(provider_case)
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]

    def test_openai_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Legacy JSON fallback should use OpenAI Responses mapping."""
        provider_case = OPENAI_RESPONSES_CASE
        flow = self._model_provider_flow(real_flow, tmp_path, provider_case)
        body = _standard_success_payload(provider_case)
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        webhook = self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
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
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":50'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "incomplete json"

    def test_json_fallback_parser_bound_error_logs_proxy_warning(self, tmp_path, real_flow):
        """Bounded parser failures should be observable without logging body content."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
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
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == "string limit exceeded"
        assert oversized_model not in proxy_log_path.read_text()

    def test_openai_json_fallback_parse_error_logs_proxy_warning(self, tmp_path, real_flow):
        """OpenAI fallback parse failures should use the same proxy warning."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

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
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)
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

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["level"] == "warn"
        assert entries[0]["message"] == "Model provider JSON usage extraction failed"
        assert entries[0]["type"] == "usage_event"
        assert entries[0]["error"] == expected_error

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
        flow = self._model_provider_flow(
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

        self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
        expected = _expected_usage(provider_case)
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected["tokens.cache_read"]
        if proxy_log_path.exists():
            entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
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
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = _standard_success_payload(provider_case)

        if encoding_case == "br":
            body = body_utils.brotli.compress(payload)
        else:
            body = zstandard.ZstdCompressor().compress(payload)

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

        webhook = self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
        expected_usage = _expected_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)
        if proxy_log_path.exists():
            entries = [json.loads(line) for line in proxy_log_path.read_text().splitlines()]
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_json_fallback_valid_body_without_usage_stays_quiet(self, tmp_path, real_flow):
        """Valid JSON without usage is not a parser failure."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1"}'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_openai_json_fallback_valid_body_without_usage_stays_quiet(self, tmp_path, real_flow):
        """OpenAI fallback should also keep valid no-usage JSON quiet."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5"}'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
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
        flow = self._model_provider_flow(
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
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(status_code=200, headers=header_map(response_headers))

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_anthropic_json_fallback_metadata_only_usage_stays_quiet(self, tmp_path, real_flow):
        """Anthropic metadata without positive token usage is not a parser failure."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"msg_1","model":"claude-sonnet-4-6"}'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == {
            "message_id": "msg_1",
            "model": "claude-sonnet-4-6",
        }
        assert not proxy_log_path.exists()

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=_model_provider_json_case_id,
    )
    def test_json_fallback_zero_token_usage_stays_quiet(self, tmp_path, real_flow, provider_case):
        """Valid zero-token usage is not a parser failure and does not bill."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
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

        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == expected_usage
        assert not proxy_log_path.exists()

    def test_codex_oauth_non_streaming_json_fallback(self, tmp_path, real_flow):
        """Codex OAuth model-provider fallback uses OpenAI Responses mapping."""
        provider_case = CODEX_OAUTH_RESPONSES_CASE
        flow = self._model_provider_flow(real_flow, tmp_path, provider_case)
        body = _standard_success_payload(provider_case)
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )

        webhook = self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
        expected = _expected_usage(provider_case)
        assert extracted["message_id"] == expected["message_id"]
        assert extracted["model"] == expected["model"]
        assert extracted["tokens.input"] == expected["tokens.input"]
        assert extracted["tokens.output"] == expected["tokens.output"]
        assert extracted["tokens.cache_read"] == expected["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == _expected_event_quantities(provider_case)

    def test_non_billable_openai_json_does_not_report_usage(self, tmp_path, real_flow):
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            billable=False,
            client_ip=None,
        )
        body = _standard_success_payload(OPENAI_RESPONSES_CASE)
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata

    def test_non_billable_json_fallback_parse_error_stays_quiet(self, tmp_path, real_flow):
        """Non-billable model-provider fallback must not emit usage warnings."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            billable=False,
            client_ip=None,
            proxy_log_path=proxy_log_path,
        )
        body = b'{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":50'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()

    def test_full_pipeline_large_model_json_uses_bounded_buffer(self, tmp_path, real_flow):
        """responseheaders + response report model usage without full-body buffering."""
        flow = self._model_provider_flow(
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
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":200}}')
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

        webhook = self._run_response(flow)

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
        flow = self._model_provider_flow(
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

        webhook = self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
        expected_usage = _expected_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
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
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = _standard_success_payload(provider_case)
        compressed = body_utils.brotli.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = self._run_response(flow)

        extracted = flow.metadata["model_provider_usage"]
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
        flow = self._model_provider_flow(
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

        webhook = self._run_response(flow)

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
        flow = self._model_provider_flow(
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

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert "stream_buffer" not in flow.metadata

    def test_full_pipeline_model_json_ignores_usage_array_shape(self, tmp_path, real_flow):
        """usage fields inside array elements must not be treated as usage object fields."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": [{"input_tokens": 50, "output_tokens": 200}],
            }
        ).encode()
        flow = self._model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            client_ip=None,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body)

        webhook = self._run_response(flow)

        assert webhook.request_count == 0

    def test_no_usage_report_for_non_model_provider(self, tmp_path, real_flow):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = real_flow(with_response=False, host="api.github.com")
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.metadata["firewall_name"] = "github"
        body = b'{"incomplete":'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert "model_provider_usage" not in flow.metadata
        assert not proxy_log_path.exists()


class TestModelProviderResponseUsageWebhookDelivery:
    """Tests for real background executor webhook delivery."""

    def test_full_path_response_to_webhook(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
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
