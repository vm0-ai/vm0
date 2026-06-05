"""Tests for X connector response and error hook lifecycle."""

import json
from pathlib import Path

import pytest
from mitmproxy.flow import Error

import body_utils
import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.x_flow_helpers import make_x_pipeline_flow, make_x_stream_pipeline_flow


class TestXConnectorResponsePipeline:
    """Tests for X connector usage through responseheaders -> response."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor, usage_webhook_api):
        """All tests here route billing through ``_call_and_get_billing`` which
        inspects webhook delivery inline; the sync executor makes that work
        without each test needing its own ``fresh_usage_executor`` + shutdown.
        """
        self._usage_webhook_api = usage_webhook_api

    def _call_and_get_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the webhook payload(s).

        Relies on the class-level ``_sync_executor`` autouse fixture to
        route submissions inline.
        """
        with self._usage_webhook_api() as webhook:
            start_count = webhook.request_count
            usage.report_connector_usage(flow, run_id)
            usage.flush_usage_events(trigger="test")
        return [
            event
            for request in webhook.requests[start_count:]
            for body in [request.json_body()]
            for event in body["events"]
        ]

    def test_full_response_pipeline_large_x_json_uses_bounded_buffer(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """responseheaders + response bill X JSON without full-body buffering."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="expansions=author_id")

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"includes":{"users":[{"id":"u1"}]},"meta":{"result_count":1}}')
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"posts.read": 1, "user.read": 1}

    def test_full_response_pipeline_brotli_x_json_uses_bounded_fallback(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Brotli streaming decode is skipped, but X JSON fallback remains active."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, content_encoding="br")

        with mitm_ctx() as log:
            mitm_addon.responseheaders(flow)
        response_stream(flow)(
            body_utils.brotli.compress(b'{"data":[{"id":"1"}],"includes":{"users":[{"id":"u1"}]}}')
        )

        payloads = self._call_and_get_billing(flow)

        by_category = {event["category"]: event["quantity"] for event in payloads}
        assert by_category == {"posts.read": 1, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata
        assert "x_ndjson_state" not in flow.metadata
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped (br)" in log.debug.call_args[0][0]

    def test_full_response_pipeline_x_data_object_bills_single_resource(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Selective X JSON extraction must count a top-level data object as one resource."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/1",
            rule="GET /2/tweets/{id}",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":{"id":"1","text":"hello"}}')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 1

    def test_full_response_pipeline_x_soft_error_ignores_request_hints(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Parsed X soft errors must not fall back to URL hints and bill missing resources."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="ids=1,2,3")

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            json.dumps(
                {
                    "errors": [
                        {
                            "title": "Not Found Error",
                            "detail": "Could not find tweets for ids: [1, 2, 3].",
                        }
                    ]
                }
            ).encode()
        )

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_full_response_pipeline_x_root_array_uses_request_hints(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Non-object JSON roots stay unparsed so request-side hints still bill."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, path="/2/tweets?ids=1,2,3")

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'[{"id":"1"}]')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 3

    def test_full_streaming_pipeline_filtered_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """End-to-end: responseheaders registers parser, chunks accumulate, response() logs."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        # 1. responseheaders - registers NDJSON parser
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

        # 2. Stream chunks (including keep-alives and a mid-line split)
        chunks = [
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n',
            b"\n",  # keep-alive
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n',
            b'{"data":{"id":"3"}',  # split mid-line
            b',"includes":{"users":[{"id":"u3"}]}}\n',
        ]
        for chunk in chunks:
            callback(chunk)

        # 3. Simulated disconnect - response() fires and logs via webhook
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        # 4. Verify billing payloads
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # 3 tweets primary + 0 from includes.tweets (none here) = 3
        assert by_cat["posts.read"] == 3
        # 3 users from includes
        assert by_cat["user.read"] == 3

    def test_full_streaming_pipeline_counts_final_line_without_newline(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """End-to-end: response() finalizes a complete NDJSON row without trailing newline."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata

    def test_full_streaming_pipeline_ignores_malformed_include_values(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Malformed include values are ignored while valid siblings still bill."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

        callback(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":null,'
            b'"tweets":{"id":"t1"},'
            b'"media":[{"media_key":"m1"}]}}\n'
        )
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 1
        assert state["includes"] == {"media": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert by_cat == {"posts.read": 1, "media.read": 1}

    def test_full_streaming_pipeline_bounds_unknown_include_categories(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Long-lived streams fold unknown include overflow into one fallback-priced bucket."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        for index in range(70):
            callback(
                b'{"data":{"id":"'
                + str(index).encode()
                + b'"},"includes":{"future_'
                + str(index).encode()
                + b'":[{"id":"u"}]}}\n'
            )
        callback(b'{"data":{"id":"known"},"includes":{"users":[{"id":"user"}]}}\n')
        state = flow.metadata["x_ndjson_state"]
        assert state["unknown_includes_overflow_count"] == 6
        assert state["includes"]["users"] == 1

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert by_cat["posts.read"] == 71
        assert by_cat["user.read"] == 1
        assert by_cat["includes.future_0"] == 1
        assert by_cat["includes.future_63"] == 1
        assert "includes.future_64" not in by_cat
        assert by_cat["includes.__overflow__"] == 6
        assert len(by_cat) == 67
        assert all(len(category) <= 100 for category in by_cat)

    def test_response_logs_incremental_x_json_parse_error(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor
    ):
        """Full response hook should audit parse errors from the incremental X JSON parser."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            sandbox_value="tok-xyz",
            rule="GET /2/tweets/search/recent",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["level"] == "error"
        assert entry["body_truncated"] is False
        assert isinstance(entry["parse_error"], str)
        assert entry["parse_error"]
        assert "connector_response_finish" not in flow.metadata

    def test_response_logs_x_json_parse_error_after_forensic_buffer_truncates(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor
    ):
        """The X JSON parser should stay authoritative after the forensic buffer fills."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            sandbox_value="tok-xyz",
            rule="GET /2/tweets/search/recent",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"},' + b" " * body_utils.STREAM_BUFFER_LIMIT)
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["level"] == "error"
        assert entry["body_truncated"] is False
        assert entry["parse_error"] == "incomplete json"
        assert "connector_response_finish" not in flow.metadata

    def test_response_uses_request_hints_for_incremental_x_json_parse_error(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor
    ):
        """Incremental X JSON parser failures should still bill from URL hints."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets?ids=1,2,3",
            sandbox_value="tok-xyz",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 3
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert all(entry["level"] != "error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)
        assert all("parse_error" not in entry for entry in entries)
        assert "connector_response_finish" not in flow.metadata


class TestXConnectorErrorPipeline:
    """Tests for X connector usage through responseheaders -> error."""

    def test_error_logs_connector_usage_for_x_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Mid-flight stream crash: partial counts still reported (issue #9534)."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        flow.metadata["x_ndjson_state"] = {
            "data_count": 23,
            "includes": {"users": 5},
            "lines_parsed": 23,
            "lines_failed": 0,
        }
        flow.metadata["stream_buffer"] = bytearray()
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count > 0
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 23
        assert by_cat["user.read"] == 5

    def test_full_pipeline_stream_error_midflight(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """End-to-end: responseheaders -> partial chunks -> error() logs observed counts.

        Simulates a real scenario: stream opens successfully, a few tweets
        arrive, then the connection resets.  No pre-populated state: the
        incremental parser must have accumulated counts from the chunks.
        """
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert "x_ndjson_state" in flow.metadata

        # 2. Receive two complete tweets, then a partial third (cut off)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"}}\n')
        callback(b'{"data":{"id":"3"}')  # no trailing newline; connection dies here

        # 3. Connection aborts
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        # 4. Billing must reflect the 2 complete tweets (partial 3rd is dropped)
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 2  # not 3; partial trailing dropped
        assert by_cat["user.read"] == 1

    def test_full_pipeline_stream_error_counts_complete_final_line_without_newline(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Connection error finalizes a complete NDJSON row without trailing newline."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}')
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata
