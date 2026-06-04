"""Tests for connector usage reporting."""

import gzip
import json
import zlib
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy.test import tutils

import body_utils
import mitm_addon
import usage
from tests.flow_helpers import header_map, response_stream


class TestXStreamPathRouting:
    """Tests for stream path routing through responseheaders (issue #9534)."""

    def _make_x_response_flow(self, real_flow, path: str):
        flow = real_flow(with_response=False, host="api.x.com", path=path)
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = f"https://api.x.com{path}"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        return flow

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream",
            "/2/tweets/sample/stream",
            "/2/tweets/sample10/stream",
            "/2/tweets/compliance/stream",
            "/2/users/compliance/stream",
        ],
    )
    def test_stream_endpoints_register_ndjson_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_absolute_form_request_target_registers_ndjson_parser_from_original_url(
        self, real_flow
    ):
        flow = self._make_x_response_flow(
            real_flow,
            "/2/tweets/search/stream?tweet.fields=id",
        )
        flow.request.path = "https://api.x.com/2/tweets/search/stream?tweet.fields=id"

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_stream_parser_requires_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata.pop("original_url")

        with pytest.raises(ValueError, match="original_url"):
            mitm_addon.responseheaders(flow)

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream/rules",
            "/2/tweets/search/recent",
            "/2/users/by",
            "/2/tweets/1",
            "",
            "/",
        ],
    )
    def test_non_stream_paths_register_json_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_brotli_stream_path_skips_response_body_parser(self, real_flow, mitm_ctx):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.response.headers = header_map(
            {"content-type": "application/json", "content-encoding": "br"}
        )

        with mitm_ctx() as log:
            mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped (br)" in log.debug.call_args[0][0]

    def test_unregistered_parser_factory_does_not_require_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "github"
        flow.metadata.pop("original_url")

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata


class TestReportConnectorUsage:
    """Tests for report_connector_usage helper (issue #9504)."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor, usage_webhook_api):
        """All tests here route billing through ``_call_and_get_billing`` which
        inspects webhook delivery inline; the sync executor makes that work
        without each test needing its own ``fresh_usage_executor`` + shutdown.
        """
        self._usage_webhook_api = usage_webhook_api

    def _make_x_flow(
        self,
        real_flow,
        tmp_path,
        *,
        path="/2/tweets",
        query="",
        body=b"",
        status=200,
        permission="tweet.read",
        rule="GET /2/tweets",
        content_encoding="",
        request_body: bytes | None = None,
        request_encoding: str | None = None,
    ):
        flow = real_flow(
            with_response=False,
            host="api.x.com",
            path=path,
            request_body=request_body,
            request_encoding=request_encoding,
        )
        flow.metadata["original_url"] = (
            f"https://api.x.com{path}?{query}" if query else f"https://api.x.com{path}"
        )
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = permission
        flow.metadata["firewall_rule_match"] = rule
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.response = tutils.tresp(
            status_code=status,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": content_encoding,
                }
            ),
        )
        return flow

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

    def _call_and_get_single_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the single webhook payload."""
        payloads = self._call_and_get_billing(flow, run_id)
        assert len(payloads) == 1, f"expected 1 billing record, got {len(payloads)}"
        return payloads[0]

    # ---- positive cases ----

    def test_logs_single_resource_get(self, tmp_path, real_flow):
        """GET /2/tweets/:id -> category=tweet.read, quantity=1."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 1

    def test_logs_batch_ids(self, tmp_path, real_flow):
        """GET /2/tweets?ids=1,2,3 -> category=tweet.read, quantity=3."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 3

    def test_logs_batch_ids_with_deletions(self, tmp_path, real_flow):
        """Batch with some missing ids -> bills actual data returned."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 2

    def test_logs_expansions_includes(self, tmp_path, real_flow):
        """?expansions=author_id -> three billing payloads for each resource type."""
        body = json.dumps(
            {
                "data": [{"id": "1", "author_id": "99"}],
                "includes": {
                    "users": [{"id": "99"}],
                    "media": [{"media_key": "m1"}, {"media_key": "m2"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query="expansions=author_id,attachments.media_keys",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {"posts.read": 1, "user.read": 1, "media.read": 2}

    def test_posts_usage_events_as_one_batch(self, tmp_path, real_flow):
        """One X response with multiple categories sends one batched webhook."""
        body = json.dumps(
            {
                "data": [{"id": "1", "author_id": "99"}],
                "includes": {"users": [{"id": "99"}]},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query="expansions=author_id",
            body=body,
        )

        with self._usage_webhook_api() as webhook:
            usage.report_connector_usage(flow, "run-abc-123")
            assert webhook.request_count == 0
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        [payload] = webhook.json_bodies()
        assert payload["runId"] == "run-abc-123"
        assert "idempotencyKey" not in payload
        by_cat = {event["category"]: event for event in payload["events"]}
        assert set(by_cat) == {"posts.read", "user.read"}
        assert by_cat["posts.read"]["kind"] == "connector"
        assert by_cat["posts.read"]["provider"] == "x"
        assert by_cat["posts.read"]["quantity"] == 1
        assert by_cat["user.read"]["quantity"] == 1

    def test_bounds_unknown_include_categories_before_buffering(self, tmp_path, real_flow):
        """Unknown includes cannot create unbounded synthetic usage categories."""
        body = json.dumps(
            {
                "data": [],
                "includes": {f"future_{index}": [{"id": str(index)}] for index in range(101)},
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="expansions=future", body=body)

        with self._usage_webhook_api() as webhook:
            usage.report_connector_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        bodies = webhook.json_bodies()
        assert [len(body["events"]) for body in bodies] == [65]
        assert {body["runId"] for body in bodies} == {"run-abc-123"}
        assert all(
            event["kind"] == "connector" and event["provider"] == "x"
            for body in bodies
            for event in body["events"]
        )
        by_cat = {
            event["category"]: event["quantity"] for body in bodies for event in body["events"]
        }
        assert len(by_cat) == 65
        assert "includes.future_0" in by_cat
        assert "includes.future_63" in by_cat
        assert "includes.future_64" not in by_cat
        assert by_cat["includes.__overflow__"] == 37
        assert all(len(category) <= 100 for category in by_cat)

    def test_overlong_unknown_include_key_uses_overflow_category(self, tmp_path, real_flow):
        """Unsafe synthetic categories are folded into the fallback-priced overflow bucket."""
        overlong_key = "x" * 92
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {
                    overlong_key: [{"id": "long"}],
                    "bad/key": [{"id": "unsafe"}, {"id": "unsafe-2"}],
                    "__overflow__": [{"id": "reserved"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="expansions=future", body=body)

        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}

        assert by_cat == {"posts.read": 1, "includes.__overflow__": 4}
        assert all(len(category) <= 100 for category in by_cat)

    def test_empty_search_emits_no_billing(self, tmp_path, real_flow):
        """Search returning zero results emits no usage_event row."""
        body = json.dumps({"data": [], "meta": {"result_count": 0}}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=nothing",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        payloads = self._call_and_get_billing(flow)
        assert payloads == []

    def test_soft_error_with_request_hints_emits_no_billing(self, tmp_path, real_flow):
        """HTTP 200 + errors array + no data field emits no usage_event
        row (issue #9620)."""
        body = json.dumps(
            {
                "errors": [
                    {
                        "value": "999999999999999999",
                        "detail": "Could not find tweet with id: [999999999999999999].",
                        "title": "Not Found Error",
                        "resource_type": "tweet",
                        "parameter": "id",
                        "type": "https://api.twitter.com/2/problems/resource-not-found",
                    }
                ]
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            query="ids=999999999999999999",
            body=body,
            rule="GET /2/tweets",
        )
        payloads = self._call_and_get_billing(flow)
        assert payloads == []

    def test_zero_result_search_with_max_results_emits_no_billing(self, tmp_path, real_flow):
        """Search with max_results=10 returning 0 results emits no
        usage_event row (issue #9620)."""
        body = json.dumps({"meta": {"result_count": 0, "newest_id": None}}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=xyzzy_no_results&max_results=10",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        payloads = self._call_and_get_billing(flow)
        assert payloads == []

    def test_logs_expansions_users_and_referenced_tweets(self, tmp_path, real_flow):
        """includes.users and includes.tweets produce two billing payloads."""
        body = json.dumps(
            {
                "data": [{"id": "1", "author_id": "99", "referenced_tweets": [{"id": "ref1"}]}],
                "includes": {
                    "users": [{"id": "99"}, {"id": "author2"}],
                    "tweets": [{"id": "ref1"}, {"id": "ref2"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query="expansions=author_id,referenced_tweets.id",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {
            "posts.read": 3,  # 1 primary + 2 referenced tweets
            "user.read": 2,
        }

    def test_handles_unknown_includes_key(self, tmp_path, real_flow):
        """Unknown includes.<key> types emit a synthetic ``includes.<key>``
        category (the billing processor applies a server-side fallback
        price) and emit a warn log at the decision point."""
        sensitive_query = "vm0-sensitive-unknown-includes"
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {
                    "users": [{"id": "99"}],
                    "future_widget": [{"id": "w1"}, {"id": "w2"}, {"id": "w3"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path=f"/2/tweets?expansions=author_id&query={sensitive_query}",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # 1 primary (posts.read) + 1 users include (mapped to user.read)
        # + 3 unknown-widget includes (emitted as `includes.future_widget`).
        assert by_cat == {
            "posts.read": 1,
            "user.read": 1,
            "includes.future_widget": 3,
        }
        proxy_log = tmp_path / "proxy.jsonl"
        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "future_widget" in content
        assert "unrecognised" in content.lower()
        assert '"level":"warn"' in content or '"level": "warn"' in content
        assert sensitive_query not in content
        entries = [json.loads(line) for line in content.splitlines()]
        matching_entries = [
            entry
            for entry in entries
            if entry.get("level") == "warn" and "unrecognised" in entry.get("message", "").lower()
        ]
        assert len(matching_entries) == 1
        entry = matching_entries[0]
        assert entry["url"] == "https://api.x.com/2/tweets"

    def test_logs_search_meta_result_count(self, tmp_path, real_flow):
        """Search response with meta.result_count -> quantity=20."""
        body = json.dumps(
            {
                "data": [{"id": str(i)} for i in range(20)],
                "meta": {"result_count": 20, "next_token": "abc"},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=hello&max_results=100",
            body=body,
            permission="tweet.read",
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 20

    def test_logs_users_by_usernames_batch(self, tmp_path, real_flow):
        """GET /2/users/by?usernames=a,b,c -> category=users.read, quantity=2."""
        body = json.dumps(
            {"data": [{"id": "1", "username": "a"}, {"id": "2", "username": "b"}]}
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/users/by",
            query="usernames=a,b,c",
            body=body,
            permission="users.read",
            rule="GET /2/users/by",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "user.read"
        assert p["quantity"] == 2

    def test_logs_tweet_counts_total_tweet_count(self, tmp_path, real_flow):
        """GET /2/tweets/counts/recent -> category=tweet.read, quantity=12567."""
        body = json.dumps(
            {
                "data": [
                    {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 8000},
                    {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 4567},
                ],
                "meta": {"total_tweet_count": 12567},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent",
            query="query=hello",
            body=body,
            rule="GET /2/tweets/counts/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 12567

    def test_tweet_counts_zero_total_does_not_bill_buckets(self, tmp_path, real_flow):
        """Count endpoint data arrays are time buckets, not returned posts."""
        body = json.dumps(
            {
                "data": [
                    {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 0},
                    {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 0},
                ],
                "meta": {"total_tweet_count": 0},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent",
            query="query=nothing",
            body=body,
            rule="GET /2/tweets/counts/recent",
        )

        assert self._call_and_get_billing(flow) == []

    @pytest.mark.parametrize(
        "path",
        ["/2/tweets/counts/recent", "/2/tweets/counts/all"],
    )
    def test_tweet_counts_total_lower_than_bucket_count_bills_total(
        self, tmp_path, real_flow, path
    ):
        """Both count endpoints bill total_tweet_count, not time-bucket count."""
        body = json.dumps(
            {
                "data": [
                    {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 1},
                    {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 0},
                    {"start": "2026-04-16T00:00", "end": "2026-04-17T00:00", "tweet_count": 0},
                ],
                "meta": {"total_tweet_count": 1},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path=path,
            query="query=rare",
            body=body,
            rule=f"GET {path}",
        )

        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 1

    def test_tweet_counts_path_matching_requires_exact_endpoint(self, tmp_path, real_flow):
        body = json.dumps(
            {
                "data": [{"id": "1"}, {"id": "2"}, {"id": "3"}],
                "meta": {"total_tweet_count": 1},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent/extra",
            body=body,
            rule="GET /2/tweets/counts/recent/extra",
        )

        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 3

    def test_tweet_counts_missing_total_skips_billing_and_logs_warning(self, tmp_path, real_flow):
        """Parsed count endpoint responses without total_tweet_count should not bill buckets."""
        body = json.dumps(
            {
                "data": [
                    {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 2},
                    {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 3},
                ],
                "meta": {},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent",
            query="query=missing_total",
            body=body,
            rule="GET /2/tweets/counts/recent",
        )

        assert self._call_and_get_billing(flow) == []

        proxy_log = tmp_path / "proxy.jsonl"
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert any(
            entry["level"] == "warn" and "total_tweet_count" in entry["message"]
            for entry in entries
        )

    def test_tweet_counts_unparseable_ignores_request_hints_and_logs_error(
        self, tmp_path, real_flow
    ):
        """Count endpoint request hints do not represent returned post count."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent",
            query="max_results=50",
            body=b"not json",
            rule="GET /2/tweets/counts/recent",
        )

        assert self._call_and_get_billing(flow) == []

        proxy_log = tmp_path / "proxy.jsonl"
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert any(
            entry["level"] == "error" and "count endpoint" in entry["message"] for entry in entries
        )

    def test_handles_gzip_body(self, tmp_path, real_flow):
        """gzip-encoded response body decompresses before parsing."""
        raw = json.dumps({"data": [{"id": "1"}], "meta": {"result_count": 1}}).encode()
        body = gzip.compress(raw)
        flow = self._make_x_flow(real_flow, tmp_path, body=body, content_encoding="gzip")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 1

    def test_full_response_pipeline_large_x_json_uses_bounded_buffer(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """responseheaders + response bill X JSON without full-body buffering."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets?expansions=author_id"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/1")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/1"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/{id}"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets?ids=1,2,3"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets?ids=1,2,3")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets?ids=1,2,3"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'[{"id":"1"}]')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 3

    def test_logs_write_operation_charges_one(self, tmp_path, real_flow):
        """POST /2/tweets (no request body parsed) -> stay on the expensive
        with_url bucket, quantity=1."""
        body = json.dumps({"data": {"id": "99", "text": "new tweet"}}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=body,
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1

    def test_x_json_parse_error_on_write_does_not_emit_lost_visibility_log(
        self, tmp_path, real_flow
    ):
        """Write operations bill by method and should not emit read visibility errors."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.metadata["x_json_state"] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": "incomplete json",
        }
        proxy_log = tmp_path / "proxy.jsonl"

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1
        assert proxy_log.exists()
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert all(entry["level"] != "error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)
        assert all("parse_error" not in entry for entry in entries)

    def test_tweet_create_plain_text_downgrades_to_content_create(self, tmp_path, real_flow):
        """POST /2/tweets with text only (no URL, no quote, no media)
        downgrades to the cheaper Content: Create bucket."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = json.dumps({"text": "hello world"}).encode()
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create"
        assert p["quantity"] == 1

    @pytest.mark.parametrize(
        ("request_encoding", "request_body"),
        [
            ("gzip", gzip.compress(json.dumps({"text": "hello world"}).encode())),
            ("deflate", zlib.compress(json.dumps({"text": "hello world"}).encode())),
        ],
    )
    def test_tweet_create_compressed_plain_text_downgrades_to_content_create(
        self, tmp_path, real_flow, request_encoding, request_body
    ):
        """Small compressed tweet create bodies still refine to Content: Create."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
            request_body=request_body,
            request_encoding=request_encoding,
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create"
        assert p["quantity"] == 1

    def test_tweet_create_gzip_decoded_body_over_cap_stays_conservative(self, tmp_path, real_flow):
        """A gzip body that expands beyond the billing inspection cap is not refined."""
        long_text = "x" * body_utils.STREAM_BUFFER_LIMIT
        request_body = gzip.compress(json.dumps({"text": long_text}).encode())
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
            request_body=request_body,
            request_encoding="gzip",
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1

    def test_tweet_create_raw_body_over_cap_stays_conservative(self, tmp_path, real_flow):
        """An oversized identity request body is not refined."""
        request_body = b"{" + b'"text":"' + b"x" * body_utils.STREAM_BUFFER_LIMIT + b'"}'
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
            request_body=request_body,
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1

    @pytest.mark.parametrize("request_encoding", ["gzip", "br", "zstd", "x-vm0-test"])
    def test_tweet_create_invalid_or_unsupported_encoding_stays_conservative(
        self, tmp_path, real_flow, request_encoding
    ):
        """Invalid compressed or unsupported encoded bodies are not refined."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
            request_body=b'{"text":"hello world"}',
            request_encoding=request_encoding,
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1

    def test_non_refinement_flow_does_not_decode_request_body(self, tmp_path, real_flow):
        """Only body-refinement candidates should inspect request content."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/123/retweeted_by?max_results=10",
            body=json.dumps({"data": [{"id": "u1"}]}).encode(),
            permission="tweet.read",
            rule="GET /2/tweets/{id}/retweeted_by",
            request_body=gzip.compress(b'{"unused": true}'),
            request_encoding="gzip",
        )
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/123/retweeted_by?max_results=10"

        with patch(
            "mitmproxy.net.encoding.decode",
            side_effect=AssertionError("request body should not be decoded"),
        ):
            p = self._call_and_get_single_billing(flow)

        assert p["category"] == "user.read"
        assert p["quantity"] == 1

    @pytest.mark.parametrize(
        "text",
        [
            "check https://example.com",
            "check HTTPS://example.com",
            "check HtTp://www.ExaMPLE.COM/index.html",
            "Visit vm0.ai for details",
            "Visit vm0.ai.",
            "(vm0.ai)",
            "Visit go.dev",
            "Read example.museum",
            "Label:example.com",
            "Param url=example.com",
            "Pipe|example.com",
            "Visit EXAMPLE.COM",
            "Visit 123.com",
            "Visit blog.example.co.uk",
            "Open example.com/path/to/resource?search=foo&lang=en",
            "Open example.com:443/path",
            "Open xn--r8jz45g.xn--q9jyb4c",
            "IDN 例え.みんな",
            "Accent mañana.com",
            "Sharp S faß.de",
            "Fullwidth compatibility \uff26\uff2f\uff2f.com",
        ],
    )
    def test_tweet_create_with_url_stays_on_with_url_bucket(self, tmp_path, real_flow, text):
        """POST /2/tweets whose text contains a URL stays on the
        Content: Create (with URL) bucket."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = json.dumps({"text": text}).encode()
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1

    @pytest.mark.parametrize(
        "text",
        [
            "Email support@example.com",
            "Mention @twitter.com",
            "Tag #twitter.com",
            "Cash $twitter.com",
            "Path /twitter.com",
            "Archive long.test.tar.bz2",
            "Word abcHTTPS://example.com",
            "Fullwidth mention \uff20twitter.com",
            "Fullwidth tag \uff03twitter.com",
            "Plus suffix example.com+tag",
            "At suffix example.com@user",
            "Unknown example.notatld",
            "Fullwidth unknown \uff26\uff2f\uff2f.notatld",
            "Underscore foo_bar.example.com",
            "Leading hyphen -bad.com",
            "Trailing hyphen bad-.com",
        ],
    )
    def test_tweet_create_url_like_non_links_downgrade_to_content_create(
        self, tmp_path, real_flow, text
    ):
        """twitter-text-style boundary guards avoid obvious non-link
        domains while still allowing plain text to downgrade."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = json.dumps({"text": text}).encode()
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create"
        assert p["quantity"] == 1

    def test_tweet_create_rendered_link_signals_stay_on_with_url_bucket(self, tmp_path, real_flow):
        """Quote tweets, attached media, cards, and DM deep links render links;
        we stay on the expensive bucket even when the text has no URL."""
        for req_body in [
            # quote tweet
            json.dumps({"text": "nice", "quote_tweet_id": "abc"}).encode(),
            # attached media
            json.dumps({"text": "pic", "media": {"media_ids": ["42"]}}).encode(),
            # attached card
            json.dumps({"text": "card", "card_uri": "card://123"}).encode(),
            # direct-message deep link
            json.dumps(
                {
                    "text": "DM me for details",
                    "direct_message_deep_link": "https://x.com/messages/compose?recipient_id=123",
                }
            ).encode(),
        ]:
            flow = self._make_x_flow(
                real_flow,
                tmp_path,
                path="/2/tweets",
                body=json.dumps({"data": {"id": "1"}}).encode(),
                status=201,
                permission="tweet.write",
                rule="POST /2/tweets",
            )
            flow.request.method = "POST"
            flow.request.content = req_body
            p = self._call_and_get_single_billing(flow)
            assert p["category"] == "content.create_with_url"
            assert p["quantity"] == 1

    @pytest.mark.parametrize("direct_message_deep_link", ["", "   ", None, 123, {"url": "x"}])
    def test_tweet_create_invalid_direct_message_deep_link_downgrades_to_content_create(
        self, tmp_path, real_flow, direct_message_deep_link
    ):
        """Invalid DM deep-link values do not block the plain-text downgrade."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = json.dumps(
            {"text": "DM me for details", "direct_message_deep_link": direct_message_deep_link}
        ).encode()
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create"
        assert p["quantity"] == 1

    def test_tweet_create_unparseable_body_stays_conservative(self, tmp_path, real_flow):
        """A malformed request body keeps billing on the max bucket so
        we never under-charge on parse failure."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = b"not valid json at all"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"

    def test_query_string_does_not_break_literal_suffix_override(self, tmp_path, real_flow):
        """``flow.request.path`` from mitmproxy includes the query string;
        literal-suffix overrides (e.g. ``/2/tweets/{id}/retweeted_by``)
        must still fire.  Regression guard for under-charging on
        popular paginated read endpoints."""
        body = json.dumps({"data": [{"id": "u1"}, {"id": "u2"}]}).encode()
        # The helper sets flow.request.path = path (no query), so we
        # craft the path-with-query explicitly to mirror what mitmproxy
        # delivers in real traffic.
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/123/retweeted_by?max_results=10",
            body=body,
            permission="tweet.read",
            rule="GET /2/tweets/{id}/retweeted_by",
        )
        # The ?max_results metadata goes into original_url for
        # req-meta parsing to consume.
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/123/retweeted_by?max_results=10"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "user.read"
        assert p["quantity"] == 2

    def test_delete_method_charges_one(self, tmp_path, real_flow):
        """DELETE /2/tweets/{id} routes to Content: Manage, not the
        tweet.write scope default.  Writes always charge quantity=1
        regardless of response shape."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/123",
            body=b"",
            permission="tweet.write",
            rule="DELETE /2/tweets/{id}",
        )
        flow.request.method = "DELETE"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "content.manage"
        assert p["quantity"] == 1

    def test_expansion_with_empty_includes_array(self, tmp_path, real_flow):
        """includes.users is empty array -> no users.read billing record."""
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {"users": []},
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="expansions=author_id", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 1

    def test_empty_search_with_includes_emits_only_includes(self, tmp_path, real_flow):
        """Search returns 0 data but non-empty includes -> only the
        includes row is emitted; the zero-primary row is skipped."""
        body = json.dumps(
            {
                "data": [],
                "meta": {"result_count": 0},
                "includes": {"users": [{"id": "u1"}]},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=test&expansions=author_id",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "user.read"
        assert p["quantity"] == 1

    # ---- streaming: x_ndjson_state feeds billing directly (issue #9534) ----

    def test_logs_x_stream_with_ndjson_state(self, tmp_path, real_flow):
        """Stream with pre-populated x_ndjson_state -> two billing payloads."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/stream",
            body=b"",
            rule="GET /2/tweets/search/stream",
        )
        flow.metadata["x_ndjson_state"] = {
            "data_count": 50,
            "includes": {"users": 47, "tweets": 12},
            "lines_parsed": 50,
            "lines_failed": 1,
        }
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # tweet.read primary 50 + 12 from includes.tweets = 62
        assert by_cat["posts.read"] == 62
        assert by_cat["user.read"] == 47

    def test_x_stream_empty_emits_no_billing(self, tmp_path, real_flow):
        """Stream that delivered 0 tweets emits no usage_event row, and
        in particular does NOT trigger _X_UNPARSEABLE_READ_FALLBACK."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/stream",
            body=b"",
            rule="GET /2/tweets/search/stream",
        )
        flow.metadata["x_ndjson_state"] = {
            "data_count": 0,
            "includes": {},
            "lines_parsed": 0,
            "lines_failed": 0,
        }
        payloads = self._call_and_get_billing(flow)
        assert payloads == []

    # ---- fallback / unparseable cases ----

    def test_legacy_x_json_fallback_extracts_selective_field_counts(self, tmp_path, real_flow):
        """Buffered fallback should share X JSON field semantics with the selective parser."""
        body = json.dumps(
            {
                "data": [{"id": "1"}, {"id": "2"}],
                "errors": [{"title": "partial failure"}],
                "includes": {
                    "users": [{"id": "u1"}],
                    "media": [],
                    "topics": "ignored",
                },
                "meta": {"result_count": 2, "total_tweet_count": 3},
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, body=body)

        payloads = self._call_and_get_billing(flow)

        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {"posts.read": 2, "user.read": 1}

    def test_legacy_x_json_fallback_ignores_boolean_result_count(self, tmp_path, real_flow):
        body = json.dumps({"meta": {"result_count": True}}).encode()
        flow = self._make_x_flow(real_flow, tmp_path, body=body)
        proxy_log = tmp_path / "proxy.jsonl"

        payloads = self._call_and_get_billing(flow)

        assert payloads == []
        if proxy_log.exists():
            entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
            assert all(entry["level"] != "error" for entry in entries)
            assert all("unparseable" not in entry["message"].lower() for entry in entries)

    def test_truncated_buffer_with_no_hints_skips_billing(self, tmp_path, real_flow):
        """Unparseable body + no URL hints → skip emission and log an
        error.  The previous blind fallback of 100 units was removed;
        ops audits via the proxy error log instead."""
        flow = self._make_x_flow(real_flow, tmp_path, body=b"{")
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        proxy_log = tmp_path / "proxy.jsonl"

        assert self._call_and_get_billing(flow) == []

        entry = json.loads(proxy_log.read_text().splitlines()[0])
        assert entry["level"] == "error"
        assert "unparseable" in entry["message"].lower()
        assert entry["body_truncated"] is True
        assert "parse_error" not in entry

    def test_invalid_json_with_no_hints_skips_billing(self, tmp_path, real_flow):
        """Malformed body + no URL hints → skip emission (see above)."""
        flow = self._make_x_flow(real_flow, tmp_path, body=b"not json")
        assert self._call_and_get_billing(flow) == []

    def test_non_dict_json_with_no_hints_skips_billing(self, tmp_path, real_flow):
        """A valid non-object JSON response preserves the old unparseable fallback."""
        flow = self._make_x_flow(real_flow, tmp_path, body=b"[1,2,3]")
        assert self._call_and_get_billing(flow) == []

    def test_array_element_fields_do_not_drive_x_billing(self, tmp_path, real_flow):
        """Fields under array elements must not masquerade as top-level X metadata."""
        body = json.dumps(
            {
                "data": [],
                "includes": [{"users": [{"id": "u1"}]}],
                "meta": [{"result_count": 5}],
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, body=body)
        assert self._call_and_get_billing(flow) == []

    def test_unparseable_no_hints_writes_error_to_proxy_log(self, tmp_path, real_flow):
        """Operators must be able to audit the lost-visibility case —
        the proxy log receives a structured error entry."""
        sensitive_query = "vm0-sensitive-unparseable"
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path=f"/2/tweets/search/recent?query={sensitive_query}",
            body=b"not json",
            rule="GET /2/tweets/search/recent",
        )
        flow.metadata["original_url"] = (
            f"https://api.x.com:8443/2/tweets/search/recent?query={sensitive_query}"
        )
        proxy_log = tmp_path / "proxy.jsonl"
        assert self._call_and_get_billing(flow) == []
        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert sensitive_query not in content
        entries = [json.loads(line) for line in content.splitlines()]
        matching_entries = [
            entry
            for entry in entries
            if entry.get("level") == "error" and "unparseable" in entry.get("message", "").lower()
        ]
        assert len(matching_entries) == 1
        entry = matching_entries[0]
        assert entry["level"] == "error"
        assert "unparseable" in entry["message"].lower()
        assert entry["permission"] == "tweet.read"
        assert entry["url"] == "https://api.x.com:8443/2/tweets/search/recent"
        assert "parse_error" not in entry

    def test_unparseable_x_json_state_logs_parse_error(self, tmp_path, real_flow):
        """Incremental parser failures should surface the parse reason for audit."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            rule="GET /2/tweets/search/recent",
        )
        flow.metadata["x_json_state"] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": "incomplete json",
        }
        proxy_log = tmp_path / "proxy.jsonl"

        assert self._call_and_get_billing(flow) == []

        entry = json.loads(proxy_log.read_text().splitlines()[0])
        assert entry["level"] == "error"
        assert "unparseable" in entry["message"].lower()
        assert entry["parse_error"] == "incomplete json"

    @pytest.mark.parametrize(
        "parse_error",
        ["", "   ", None, b"incomplete json", {"reason": "incomplete json"}],
    )
    def test_unparseable_x_json_state_omits_invalid_parse_error(
        self, tmp_path, real_flow, parse_error
    ):
        """Only non-empty string parse errors should be written to the audit log."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            rule="GET /2/tweets/search/recent",
        )
        flow.metadata["x_json_state"] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": parse_error,
        }
        proxy_log = tmp_path / "proxy.jsonl"

        assert self._call_and_get_billing(flow) == []

        entry = json.loads(proxy_log.read_text().splitlines()[0])
        assert entry["level"] == "error"
        assert "unparseable" in entry["message"].lower()
        assert "parse_error" not in entry

    def test_billable_counts_fallback_only_when_no_hints(self, tmp_path, real_flow):
        """body unparseable but ?ids= present -> uses ids_count, no fallback."""
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 3

    def test_parsed_response_ignores_oversized_fallback_query(self, tmp_path, real_flow):
        """Parsed responses bill from the body and do not need query fallback hints."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "2"}]}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query=f"ignored={'x' * 200_000}",
            body=body,
        )

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == "posts.read"
        assert p["quantity"] == 2

    def test_unparseable_response_scans_relevant_fallback_query_hints(self, tmp_path, real_flow):
        """Fallback query scanning ignores unrelated params without materializing them."""
        irrelevant_params = "&".join(f"noise{i}=value{i}" for i in range(500))
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query=f"{irrelevant_params}&ids=1,2,3",
            body=b"not json",
        )

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == "posts.read"
        assert p["quantity"] == 3

    def test_unparseable_response_accumulates_repeated_id_like_fallback_hints(
        self, tmp_path, real_flow
    ):
        """Repeated ids/usernames keep the same aggregate count behavior as parse_qs."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/users/by",
            query="ids=1,2&ids=3&usernames=a,b",
            body=b"not json",
            permission="users.read",
            rule="GET /2/users/by",
        )

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == "user.read"
        assert p["quantity"] == 5

    def test_unparseable_response_does_not_treat_semicolon_as_query_separator(
        self, tmp_path, real_flow
    ):
        """Semicolons stay inside values, matching Python 3.12 parse_qs behavior."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query="ids=1;max_results=50",
            body=b"not json",
        )

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == "posts.read"
        assert p["quantity"] == 1

    def test_oversized_fallback_query_suppresses_request_hints(self, tmp_path, real_flow):
        """Oversized fallback queries are treated as having no reliable count hints."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            query=f"ids=1,2,3&ignored={'x' * 200_000}",
            body=b"not json",
        )
        proxy_log = tmp_path / "proxy.jsonl"

        assert self._call_and_get_billing(flow) == []

        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "unparseable" in content.lower()
        assert '"level":"error"' in content or '"level": "error"' in content

    @pytest.mark.parametrize(
        ("path", "query", "permission", "rule", "expected_category", "expected_quantity"),
        [
            ("/2/tweets", "ids=1,2,3", "tweet.read", "GET /2/tweets", "posts.read", 3),
            ("/2/tweets", "max_results=50", "tweet.read", "GET /2/tweets", "posts.read", 50),
            ("/2/users/by", "usernames=a,b", "users.read", "GET /2/users/by", "user.read", 2),
        ],
    )
    def test_x_json_parse_error_with_request_hints_uses_fallback_without_error_log(
        self,
        tmp_path,
        real_flow,
        path,
        query,
        permission,
        rule,
        expected_category,
        expected_quantity,
    ):
        """Recoverable parser failures should bill from hints without lost-visibility logs."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path=path,
            query=query,
            permission=permission,
            rule=rule,
        )
        flow.metadata["x_json_state"] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": "incomplete json",
        }
        proxy_log = tmp_path / "proxy.jsonl"

        p = self._call_and_get_single_billing(flow)

        assert p["category"] == expected_category
        assert p["quantity"] == expected_quantity
        assert proxy_log.exists()
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert all(entry["level"] != "error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)
        assert all("parse_error" not in entry for entry in entries)

    def test_x_json_parse_error_with_zero_max_results_is_noop_hint(self, tmp_path, real_flow):
        """A zero max_results hint should suppress lost-visibility logs without billing."""
        flow = self._make_x_flow(real_flow, tmp_path, query="max_results=0")
        flow.metadata["x_json_state"] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": "incomplete json",
        }
        proxy_log = tmp_path / "proxy.jsonl"

        assert self._call_and_get_billing(flow) == []

        if proxy_log.exists():
            entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
            assert all(entry["level"] != "error" for entry in entries)
            assert all("unparseable" not in entry["message"].lower() for entry in entries)
            assert all("parse_error" not in entry for entry in entries)

    @pytest.mark.parametrize(
        ("query", "expected_quantity"),
        [
            ("ids=1,,2", 2),
            ("ids=,1,2,", 2),
            ("ids=1,+,2", 2),
        ],
    )
    def test_billable_counts_fallback_filters_empty_id_segments(
        self, tmp_path, real_flow, query, expected_quantity
    ):
        """body unparseable but ?ids= present -> uses non-empty id segment count."""
        flow = self._make_x_flow(real_flow, tmp_path, query=query, body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == expected_quantity

    def test_billable_counts_fallback_filters_empty_username_segments(self, tmp_path, real_flow):
        """body unparseable but ?usernames= present -> uses non-empty username count."""
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/users/by",
            query="usernames=a,,b",
            body=b"not json",
            permission="users.read",
            rule="GET /2/users/by",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "user.read"
        assert p["quantity"] == 2

    def test_billable_counts_fallback_empty_id_segments_are_no_hint(self, tmp_path, real_flow):
        """body unparseable and only empty ?ids= segments -> no billing, with audit log."""
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=,,", body=b"not json")
        proxy_log = tmp_path / "proxy.jsonl"
        assert self._call_and_get_billing(flow) == []
        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "unparseable" in content.lower()
        assert '"level":"error"' in content or '"level": "error"' in content

    def test_billable_counts_fallback_only_when_no_max_results(self, tmp_path, real_flow):
        """body unparseable but ?max_results=50 present -> uses max_results."""
        flow = self._make_x_flow(real_flow, tmp_path, query="max_results=50", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "posts.read"
        assert p["quantity"] == 50

    # ---- skip cases ----

    def test_skips_on_server_error(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path, status=500)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_rate_limit(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path, status=429)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_permission(self, tmp_path, real_flow):
        """Unknown-endpoint-allow has no stable pricing key."""
        flow = self._make_x_flow(real_flow, tmp_path, permission="")
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_run_id(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        assert self._call_and_get_billing(flow, run_id="") == []

    def test_skips_for_model_provider(self, tmp_path, real_flow):
        """Model-provider flows go through report_model_provider_usage instead.
        The dispatcher has no ``model-provider:*`` entry in ``_HANDLERS``, so
        it early-returns and never reaches the X parser even when
        firewall_billable=True."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        assert self._call_and_get_billing(flow) == []
        proxy_log = tmp_path / "proxy.jsonl"
        if proxy_log.exists():
            assert "no registered handler" not in proxy_log.read_text()

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_skips_malformed_firewall_name_without_warning(
        self, tmp_path, real_flow, firewall_name
    ):
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        flow.metadata["firewall_name"] = firewall_name

        assert self._call_and_get_billing(flow) == []

        proxy_log = tmp_path / "proxy.jsonl"
        if proxy_log.exists():
            assert "no registered handler" not in proxy_log.read_text()

    def test_skips_for_non_x_billable_firewall(self, tmp_path, real_flow):
        """Billable non-x connectors (hypothetical future additions to
        BILLABLE_CONNECTORS) must NOT reach the X parser.  The dispatcher
        drops when the firewall_name has no registered handler, which
        prevents bogus billing records if someone grows the whitelist
        without also registering a handler in ``_HANDLERS``."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = "github"
        assert self._call_and_get_billing(flow) == []

    def test_unregistered_handler_does_not_require_original_url(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = "github"
        flow.metadata.pop("original_url")

        assert self._call_and_get_billing(flow) == []

    # ---- unregistered-handler one-shot warn (issue #10483) ----

    def test_warns_once_per_unregistered_firewall_name(self, tmp_path, real_flow):
        """First billable flow for an unregistered firewall_name emits a warn;
        subsequent flows for the same name stay silent (one-shot guard)."""
        proxy_log = tmp_path / "proxy.jsonl"
        for _ in range(3):
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata["firewall_name"] = "github"
            assert self._call_and_get_billing(flow) == []

        lines = [
            json.loads(line)
            for line in proxy_log.read_text().splitlines()
            if "no registered handler" in line
        ]
        assert len(lines) == 1
        assert lines[0]["level"] == "warn"
        assert lines[0]["firewall_name"] == "github"
        assert lines[0]["type"] == "usage_event"

    def test_warns_separately_per_firewall_name(self, tmp_path, real_flow):
        """One-shot guard is per-firewall-name, not global — a new desynced
        connector name still surfaces even after an earlier one warned."""
        proxy_log = tmp_path / "proxy.jsonl"
        for name in ("github", "slack", "github"):  # github repeats; slack new
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata["firewall_name"] = name
            assert self._call_and_get_billing(flow) == []

        warned_names = [
            json.loads(line)["firewall_name"]
            for line in proxy_log.read_text().splitlines()
            if "no registered handler" in line
        ]
        assert warned_names == ["github", "slack"]

    def test_does_not_warn_on_empty_firewall_name(self, tmp_path, real_flow):
        """Empty firewall_name is a different bug class (web-layer contract
        violation) already logged elsewhere — don't double-warn here."""
        proxy_log = tmp_path / "proxy.jsonl"
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = ""
        assert self._call_and_get_billing(flow) == []

        if proxy_log.exists():
            assert "no registered handler" not in proxy_log.read_text()

    def test_skips_when_not_billable(self, tmp_path, real_flow):
        """Firewalls with firewall_billable=False are not reported."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_billable"] = False
        assert self._call_and_get_billing(flow) == []

    def test_skips_when_no_response(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.response = None
        assert self._call_and_get_billing(flow) == []

    def test_registered_x_usage_requires_original_url(self, tmp_path, real_flow, mitm_ctx):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata.pop("original_url")

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            pytest.raises(ValueError, match="original_url"),
        ):
            usage.report_connector_usage(flow, "run-abc-123")

    # ---- webhook skip ----

    def test_skips_webhook_without_sandbox_token(self, tmp_path, real_flow):
        """When sandbox token is empty, no webhook is enqueued."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        flow.metadata["vm_sandbox_token"] = ""
        assert self._call_and_get_billing(flow) == []

    # ---- full pipeline: responseheaders -> stream chunks -> response (issue #9534) ----

    def test_full_streaming_pipeline_filtered_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """End-to-end: responseheaders registers parser, chunks accumulate, response() logs."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(status_code=200)
        # X streams return application/json with chunked transfer, not x-ndjson.
        flow.response.headers = header_map({"content-type": "application/json"})
        flow.response.stream = False

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(status_code=200)
        flow.response.headers = header_map({"content-type": "application/json"})
        flow.response.stream = False

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(status_code=200)
        flow.response.headers = header_map({"content-type": "application/json"})
        flow.response.stream = False

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(status_code=200)
        flow.response.headers = header_map({"content-type": "application/json"})
        flow.response.stream = False

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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/recent")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/recent?query=vm0"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/recent"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/recent")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/recent?query=vm0"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/recent"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
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
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets?ids=1,2,3")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets?ids=1,2,3"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
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
