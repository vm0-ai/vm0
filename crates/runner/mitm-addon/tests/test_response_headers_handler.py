"""Tests for the mitm addon responseheaders hook."""

import gzip
import json
import zlib

import brotli
import pytest
import zstandard
from mitmproxy.test import tutils

import body_utils
import mitm_addon
import response_streaming
from tests.flow_helpers import header_map, response_stream


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook that enables streaming."""

    def test_enables_streaming_with_buffer(self, real_flow, headers):
        """All responses should be streamed via a buffer callback."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "stream_buffer" in flow.metadata
        assert isinstance(flow.metadata["stream_buffer"], bytearray)

    def test_stream_callback_buffers_chunks(self, real_flow, headers):
        """The stream callback should accumulate chunks in the buffer."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        result1 = callback(b"hello ")
        result2 = callback(b"world")

        assert result1 == b"hello "
        assert result2 == b"world"
        assert bytes(flow.metadata["stream_buffer"]) == b"hello world"
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

    def test_stream_callback_stops_buffering_at_limit(self, real_flow, headers):
        """Buffering should stop when exceeding the size limit."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        # Fill buffer to just under limit
        chunk = b"x" * body_utils.STREAM_BUFFER_LIMIT
        result = callback(chunk)
        assert result == chunk
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Next chunk should trigger truncation
        result2 = callback(b"overflow")
        assert result2 == b"overflow"  # still forwarded to client
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_large_single_chunk(self, real_flow, headers):
        """A single chunk larger than the limit should still capture the first part."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        big_chunk = b"A" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        result = callback(big_chunk)
        assert result == big_chunk  # full chunk forwarded to client
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_partial_fill_then_overflow(self, real_flow, headers):
        """Partial fill followed by an oversized chunk should capture up to the limit."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        half = body_utils.STREAM_BUFFER_LIMIT // 2
        callback(b"A" * half)
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # This chunk overflows — should capture up to the limit
        callback(b"B" * body_utils.STREAM_BUFFER_LIMIT)
        remaining = body_utils.STREAM_BUFFER_LIMIT - half
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer"][:half] == bytearray(b"A" * half)
        assert flow.metadata["stream_buffer"][half:] == bytearray(b"B" * remaining)
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_capture_body_also_streams(self, real_flow, headers):
        """When capture_body is set, streaming should still be enabled."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["capture_body"] = True

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "stream_buffer" in flow.metadata

    def test_stream_callback_empty_chunk(self, real_flow, headers):
        """Empty chunks should be forwarded without affecting the buffer."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        result = callback(b"")
        assert result == b""
        assert len(flow.metadata["stream_buffer"]) == 0
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Normal chunk after empty should still work
        callback(b"hello")
        assert bytes(flow.metadata["stream_buffer"]) == b"hello"

    def test_no_response_is_noop(self, real_flow):
        """Flow without response should not raise."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)  # Should not raise

    # ---- X NDJSON streaming parser registration (issue #9534) ----

    def test_x_stream_endpoint_registers_ndjson_parser(self, real_flow, headers):
        """X filtered-stream endpoint wires incremental NDJSON parser.

        Note: X streams return ``content-type: application/json`` with chunked
        transfer encoding — same as non-stream endpoints.  Stream detection is
        URL-based, not content-type-based.
        """
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n')
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 2}

    def test_x_stream_buffer_capped_at_stream_limit(self, real_flow, headers):
        """Stream endpoint must NOT buffer multi-MB bodies — uses 64 KB cap."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        # First parseable line, then ~200 KB of junk.  Parser sees the first
        # line; buffer truncates at STREAM_BUFFER_LIMIT.
        callback(b'{"data":{"id":"1"}}\n' + b"x" * (200 * 1024))
        assert len(flow.metadata["stream_buffer"]) <= body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        assert flow.metadata["x_ndjson_state"]["data_count"] == 1
        assert "connector_response_finish" in flow.metadata

    def test_x_non_stream_endpoint_uses_bounded_buffer_and_json_extractor(self, real_flow, headers):
        """Non-stream X requests parse billing JSON without unbounded buffering."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/users/by")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/users/by?ids=1,2,3"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (200 * 1024))
        callback(b'"}],"includes":{"users":[{"id":"u1"}]}}')
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        assert "x_ndjson_state" not in flow.metadata
        response_streaming.finalize_connector_response_state(flow)
        state = flow.metadata["x_json_state"]
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 1
        assert state["response_includes"] == {"users": 1}

    def test_x_stream_rules_is_not_registered_as_stream(self, real_flow, headers):
        """/2/tweets/search/stream/rules is rules mgmt, not a stream — no NDJSON parser."""
        flow = real_flow(
            with_response=False, host="api.x.com", path="/2/tweets/search/stream/rules"
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream/rules"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        # No NDJSON state registered; this endpoint is ordinary JSON, not a stream.
        assert "x_ndjson_state" not in flow.metadata

    def test_x_stream_error_response_uses_bounded_forensic_buffer(self, real_flow, headers):
        """4xx/5xx on stream endpoints does not register NDJSON or JSON billing parser.

        Error responses on stream endpoints return a single JSON error object,
        not NDJSON.  They are not billable, so the response body is only kept
        in the capped forensic buffer.
        """
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=401, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        # No NDJSON parser — error body would fail NDJSON parsing anyway.
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        callback = response_stream(flow)
        error_body = b'{"title":"Unauthorized","detail":"' + b"x" * (200 * 1024) + b'"}'
        callback(error_body)
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_x_stream_gzip_compressed_body(self, real_flow, headers):
        """Gzip-encoded NDJSON stream: decompressor + parser wire up correctly."""
        ndjson_body = (
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n'
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n'
            b'{"data":{"id":"3"},"includes":{"users":[{"id":"u3"}]}}\n'
        )
        compressed = gzip.compress(ndjson_body)

        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": "gzip",
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        # Feed compressed bytes in two chunks to exercise incremental decompression.
        mid = len(compressed) // 2
        callback(compressed[:mid])
        callback(compressed[mid:])
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 3
        assert state["includes"] == {"users": 3}
        assert "connector_response_finish" in flow.metadata

    def test_model_provider_gzip_json_extractor(self, real_flow, headers):
        """Gzip-encoded non-streaming model JSON feeds the selective extractor."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 10, "output_tokens": 20},
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(gzip.compress(body))
        usage_result, error = flow.metadata["model_json_usage_finish"]()
        assert error is None
        assert usage_result["message_id"] == "msg_1"
        assert usage_result["tokens.input"] == 10
        assert usage_result["tokens.output"] == 20

    def test_model_provider_zstd_json_scans_past_decode_chunk_limit(self, real_flow):
        """Zstd usage parsing should chunk decoded output without total truncation."""
        body = (
            b'{"id":"msg_zstd","model":"claude-sonnet-4-6","content":[{"text":"'
            + b"A" * (body_utils.STREAM_DECODE_CHUNK_LIMIT * 3)
            + b'"}],"usage":{"input_tokens":10,"output_tokens":20}}'
        )
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "zstd"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(zstandard.ZstdCompressor().compress(body))
        usage_result, error = flow.metadata["model_json_usage_finish"]()
        assert error is None
        assert usage_result["message_id"] == "msg_zstd"
        assert usage_result["tokens.input"] == 10
        assert usage_result["tokens.output"] == 20

    def test_model_provider_brotli_usage_stream_fails_closed(self, real_flow, mitm_ctx):
        """Brotli usage streams should leave JSON extraction to the bounded fallback."""
        body = json.dumps(
            {
                "id": "msg_br",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 10, "output_tokens": 20},
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )

        with mitm_ctx() as log:
            mitm_addon.responseheaders(flow)

        response_stream(flow)(brotli.compress(body))
        assert "model_json_usage_finish" not in flow.metadata
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped (br)" in log.debug.call_args[0][0]

    def test_openai_model_provider_gzip_json_extractor(self, real_flow, headers):
        """OpenAI model-provider JSON uses the Responses usage extractor."""
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "input_tokens_details": {"cached_tokens": 4},
                },
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(gzip.compress(body))
        usage_result, error = flow.metadata["model_json_usage_finish"]()
        assert error is None
        assert usage_result["message_id"] == "resp_1"
        assert usage_result["model"] == "gpt-5.5"
        assert usage_result["tokens.input"] == 6
        assert usage_result["tokens.output"] == 20
        assert usage_result["tokens.cache_read"] == 4

    def test_x_non_stream_gzip_json_extractor(self, real_flow, headers):
        """Gzip-encoded X JSON feeds the selective extractor."""
        body = json.dumps(
            {
                "data": [{"id": "1"}, {"id": "2"}],
                "includes": {"users": [{"id": "u1"}]},
                "meta": {"result_count": 2, "total_tweet_count": 3},
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(gzip.compress(body))
        response_streaming.finalize_connector_response_state(flow)
        json_state = flow.metadata["x_json_state"]
        assert json_state["response_data_count"] == 2
        assert json_state["response_includes"] == {"users": 1}
        assert json_state["response_result_count"] == 2
        assert json_state["response_total_tweet_count"] == 3

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_x_non_stream_concatenated_zlib_json_extractor(self, real_flow, headers, encoding):
        """X JSON parsing should consume payloads from later zlib members."""
        body = json.dumps(
            {
                "data": [{"id": "1"}, {"id": "2"}],
                "includes": {"users": [{"id": "u1"}]},
                "meta": {"result_count": 2, "total_tweet_count": 3},
            }
        ).encode()
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(body)
        else:
            compressed = zlib.compress(b"") + zlib.compress(body)
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": encoding}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)
        response_streaming.finalize_connector_response_state(flow)

        json_state = flow.metadata["x_json_state"]
        assert json_state["body_parsed"] is True
        assert json_state["response_data_count"] == 2
        assert json_state["response_includes"] == {"users": 1}
        assert json_state["response_result_count"] == 2
        assert json_state["response_total_tweet_count"] == 3

    def test_model_provider_uses_bounded_buffer_and_json_extractor(self, real_flow, headers):
        """Billable model provider JSON should parse usage without unbounded buffering."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":100}}')

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        usage_result, error = flow.metadata["model_json_usage_finish"]()
        assert error is None
        assert usage_result["model"] == "claude-sonnet-4-6"
        assert usage_result["message_id"] == "msg_1"
        assert usage_result["tokens.input"] == 50
        assert usage_result["tokens.output"] == 100

    def test_non_billable_model_provider_buffer_truncated(self, real_flow, headers):
        """Non-billable model providers should use the normal bounded buffer."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_provider_usage" not in flow.metadata

    def test_non_model_provider_buffer_truncated(self, real_flow, headers):
        """Non-model-provider responses should truncate at 64KB."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        # No firewall_name — not a model provider

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]

    def test_billable_x_connector_uses_bounded_buffer_and_json_extractor(self, real_flow, headers):
        """Billable X connector responses should not buffer the full body."""
        flow = real_flow(with_response=False, host="api.x.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))
        callback(b'"}],"meta":{"result_count":1}}')

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        response_streaming.finalize_connector_response_state(flow)
        json_state = flow.metadata["x_json_state"]
        assert json_state["response_data_count"] == 1
        assert json_state["response_result_count"] == 1

    def test_non_billable_x_non_stream_uses_bounded_forensic_buffer_only(self, real_flow, headers):
        """Non-billable X JSON should not attach the billable response parser."""
        flow = real_flow(with_response=False, host="api.x.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = False
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    @pytest.mark.parametrize("firewall_billable", [False, None])
    def test_non_billable_x_stream_uses_bounded_forensic_buffer_only(
        self, real_flow, headers, firewall_billable
    ):
        """Non-billable X streams should not attach the billable NDJSON parser."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        if firewall_billable is not None:
            flow.metadata["firewall_billable"] = firewall_billable
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_non_x_billable_connector_uses_bounded_forensic_buffer(self, real_flow, headers):
        """Future billable connectors must not get unbounded buffers by default."""
        flow = real_flow(with_response=False, host="api.gamma.example")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "gamma"  # hypothetical future billable connector
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        large_chunk = b"g" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        # And no X-specific state gets attached to a non-x flow.
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
