"""Response hook integration tests for network and proxy logging."""

import time
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import request_streaming
from body_limits import STREAM_BUFFER_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.request_handler_helpers import (
    _vm_without_firewalls,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


def test_calculates_latency_and_logs(registry_file, tmp_path, real_flow, mitm_ctx, headers):
    flow = real_flow(with_response=False, host="api.anthropic.com")
    log_path = str(tmp_path / "network.jsonl")

    # Simulate request handler setting metadata
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"

    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.anthropic.com/"

    # Add response
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "content-length": "256",
                "content-type": "application/json",
                "content-encoding": "gzip",
                "transfer-encoding": "chunked",
            }
        ),
    )

    # Simulate tracked start time
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic() - 0.1

    with mitm_ctx():
        mitm_addon.response(flow)

    # Start time should be cleaned up
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    # Network log should be written
    entries = read_jsonl_entries_after_flush(Path(log_path))
    assert len(entries) == 1
    entry = entries[0]
    assert entry["action"] == "ALLOW"
    assert entry["host"] == "api.anthropic.com"
    assert entry["latency_ms"] > 0
    assert entry["response_size"] == 256
    assert_utc_millisecond_timestamp(entry["timestamp"])


def test_logs_request_time_network_log_target(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="request.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://original.example.com/"
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": "https://target.example.com:9443/path",
        "host": "target.example.com",
        "port": 9443,
    }
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == 9443
    assert entry["url"] == "https://target.example.com:9443/path"


def test_response_log_includes_firewall_auth_metadata(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.example.com", path="/items")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata.update(
        {
            metadata_keys.VM_RUN_ID: "run-abc-123",
            metadata_keys.VM_NETWORK_LOG_PATH: log_path,
            metadata_keys.ORIGINAL_URL: "https://api.example.com/items",
            metadata_keys.FIREWALL_ACTION: "ALLOW",
            metadata_keys.FIREWALL_BASE: "https://api.example.com",
            metadata_keys.FIREWALL_NAME: "model-provider:example",
            metadata_keys.FIREWALL_PERMISSION: "read",
            metadata_keys.FIREWALL_RULE_MATCH: "GET /items",
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.FIREWALL_PARAMS: {"owner": "vm0-ai", "repo": "vm0"},
            metadata_keys.AUTH_RESOLVED_SECRETS: ["GITHUB_TOKEN"],
            metadata_keys.AUTH_REFRESHED_CONNECTORS: ["github"],
            metadata_keys.AUTH_REFRESHED_SECRETS: ["GITHUB_TOKEN"],
            metadata_keys.AUTH_CACHE_HIT: False,
            metadata_keys.AUTH_URL_REWRITE: True,
        }
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["firewall_base"] == "https://api.example.com"
    assert entry["firewall_name"] == "model-provider:example"
    assert entry["firewall_permission"] == "read"
    assert entry["firewall_rule_match"] == "GET /items"
    assert entry["firewall_billable"] is True
    assert entry["firewall_params"] == {"owner": "vm0-ai", "repo": "vm0"}
    assert entry["auth_resolved_secrets"] == ["GITHUB_TOKEN"]
    assert entry["auth_refreshed_connectors"] == ["github"]
    assert entry["auth_refreshed_secrets"] == ["GITHUB_TOKEN"]
    assert entry["auth_cache_hit"] is False
    assert entry["auth_url_rewrite"] is True


@pytest.mark.parametrize(
    "with_firewall_context",
    [False, True],
    ids=["without-firewall", "with-firewall"],
)
@pytest.mark.parametrize(
    ("route_candidates", "expected_candidates"),
    [
        pytest.param(None, None, id="absent"),
        pytest.param([], None, id="empty"),
        pytest.param(["primary", None], None, id="malformed"),
        pytest.param(["auditor", "primary"], ["auditor", "primary"], id="populated"),
    ],
)
def test_response_log_serializes_common_metadata_independent_of_firewall_context(
    tmp_path,
    real_flow,
    mitm_ctx,
    with_firewall_context,
    route_candidates,
    expected_candidates,
):
    flow = real_flow(with_response=False, host="api.example.com", path="/items")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata.update(
        {
            metadata_keys.VM_RUN_ID: "run-abc-123",
            metadata_keys.VM_NETWORK_LOG_PATH: log_path,
            metadata_keys.ORIGINAL_URL: "https://api.example.com/items",
            metadata_keys.FIREWALL_ACTION: "DENY",
            metadata_keys.FIREWALL_ERROR: "ambiguous_connector_route",
            metadata_keys.CONNECTOR_ROUTE_REASON: "connector_intent_required",
        }
    )
    if route_candidates is not None:
        flow.metadata[metadata_keys.CONNECTOR_ROUTE_CANDIDATES] = route_candidates
    if with_firewall_context:
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_BASE: "https://api.example.com",
                metadata_keys.FIREWALL_NAME: "example",
                metadata_keys.FIREWALL_PERMISSION: "read",
                metadata_keys.FIREWALL_RULE_MATCH: "GET /items",
                metadata_keys.FIREWALL_BILLABLE: False,
            }
        )
    flow.response = tutils.tresp(status_code=409, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["firewall_error"] == "ambiguous_connector_route"
    assert entry["connector_route_reason"] == "connector_intent_required"
    if expected_candidates is None:
        assert "connector_route_candidates" not in entry
    else:
        assert entry["connector_route_candidates"] == expected_candidates
    if with_firewall_context:
        assert entry["firewall_base"] == "https://api.example.com"
        assert entry["firewall_name"] == "example"
    else:
        assert "firewall_base" not in entry
        assert "firewall_name" not in entry


@pytest.mark.parametrize(
    ("raw_url", "expected_url"),
    [
        (
            "https://target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path",
        ),
        (
            "https://[invalid.example.com/path?access_token=secret#fragment",
            "https://[invalid.example.com/path",
        ),
        (
            "https://user:pass@[invalid.example.com/path?access_token=secret#fragment",
            "https://[invalid.example.com/path",
        ),
        (
            "//user:pass@[invalid.example.com/path?access_token=secret#fragment",
            "//[invalid.example.com/path",
        ),
        (
            "https://user:pass@target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path",
        ),
        (
            "https:////user:pass@target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path",
        ),
        (
            "https://target.example.com:9443/users/alice@example.com?access_token=secret#fragment",
            "https://target.example.com:9443/users/alice@example.com",
        ),
    ],
)
def test_network_log_target_url_strips_query_and_fragment(
    tmp_path, real_flow, mitm_ctx, raw_url, expected_url
):
    flow = real_flow(with_response=False, host="request.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": raw_url,
        "host": "target.example.com",
        "port": 9443,
    }
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == 9443
    assert entry["url"] == expected_url
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == raw_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url


@pytest.mark.parametrize(
    ("original_url", "expected_port"),
    [
        ("http://target.example.com:0/path", 0),
        ("https://target.example.com:0/path", 0),
        ("http://target.example.com/path", 80),
        ("https://target.example.com/path", 443),
    ],
)
def test_logs_explicit_or_default_original_url_port(
    tmp_path, real_flow, mitm_ctx, original_url, expected_port
):
    flow = real_flow(with_response=False, host="request.example.com", port=9443)
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == expected_port
    assert entry["url"] == original_url


def test_logs_legacy_target_when_original_url_port_is_invalid(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="fallback.example.com", port=9443)
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        "https://invalid.example.com:bad/path?secret=value#frag"
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "fallback.example.com"
    assert entry["port"] == 9443
    assert entry["url"] == "https://invalid.example.com:bad/path"


def test_response_size_tracks_streamed_bytes(tmp_path, real_flow, mitm_ctx):
    """response_size should use cumulative streamed bytes."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "999", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(b"x" * 40)
    response_stream(flow)(b"y" * 60)

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 100


def test_response_size_tracks_large_stream_without_body_buffer(tmp_path, real_flow, mitm_ctx):
    """A large ordinary response keeps exact size without retaining a prefix."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 4096)

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "12", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    assert response_stream(flow)(body[:123]) == body[:123]
    assert response_stream(flow)(body[123:]) == body[123:]
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == len(body)


def test_request_size_tracks_streamed_bytes_and_captures_stream_body(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        method="POST",
        request_body=b"should-be-ignored",
        request_content_type="text/plain",
    )
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 17)

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "0", "content-type": "application/json"}),
    )

    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(body[:123]) == body[:123]
    assert stream(body[123:]) == body[123:]

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["request_size"] == len(body)
    assert entry["request_body"] == "x" * STREAM_BUFFER_LIMIT
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_firewalled_streamed_request_logs_size_and_capture_body(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "text/plain"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 17)),
        ),
    )
    body = b"x" * (STREAM_BUFFER_LIMIT + 17)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(body[:123]) == body[:123]
        assert stream(body[123:]) == body[123:]
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    auth_fetch.assert_awaited_once()
    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == len(body)
    assert entry["request_body"] == "x" * STREAM_BUFFER_LIMIT
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_firewalled_partial_streamed_request_marks_capture_truncated(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(b'{"partial":true') == b'{"partial":true'
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == len(b'{"partial":true')
    assert entry["request_body"] == '{"partial":true'
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True


async def test_firewalled_empty_incomplete_streamed_request_marks_capture_truncated(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        assert callable(flow.request.stream)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == 0
    assert "request_body" not in entry
    assert "request_body_encoding" not in entry
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_unknown_length_get_without_body_logs_zero_request_size(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "2", "content-type": "text/plain"}),
            content=b"ok",
        )
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == 0
    assert "request_body" not in entry
    assert "request_body_encoding" not in entry
    assert "request_body_truncated" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_early_response_makes_late_request_hook_noop(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata
        stream = flow.request.stream
        assert callable(stream)
        assert stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "2", "content-type": "text/plain"}),
            content=b"ok",
        )
        mitm_addon.response(flow)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        reg_path.write_text("{ broken registry")
        await mitm_addon.request(flow)

    assert flow.response.status_code == 200
    assert flow.response.content == b"ok"
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


@pytest.mark.parametrize(
    ("content_length", "expected_size"),
    [
        pytest.param("50000", 50000, id="plain"),
        pytest.param(" 50000\t", 50000, id="optional-whitespace"),
        pytest.param("10, 10", 10, id="joined-consistent"),
        pytest.param("00042, 42", 42, id="joined-leading-zero-consistent"),
        pytest.param("0" * 32 + "42", 42, id="leading-zero-safe-integer"),
    ],
)
def test_response_size_uses_content_length_without_stream_state(
    tmp_path, real_flow, mitm_ctx, content_length, expected_size
):
    """response_size should fall back to Content-Length without stream metadata."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": content_length})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == expected_size


def test_response_size_accepts_max_safe_content_length(tmp_path, real_flow, mitm_ctx):
    """response_size should accept the largest exactly representable JavaScript integer."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": "9007199254740991"})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 9007199254740991


def test_response_size_is_zero_without_stream_state_or_content_length(
    tmp_path, real_flow, mitm_ctx
):
    """response_size should be 0 when no streamed size or Content-Length exists."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-type": "application/json"})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


@pytest.mark.parametrize(
    "content_length",
    [
        pytest.param("", id="empty"),
        pytest.param(" ", id="space"),
        pytest.param("\t", id="tab"),
        pytest.param("not-an-int", id="malformed"),
        pytest.param("-1", id="negative"),
        pytest.param("+1", id="signed"),
        pytest.param("1.5", id="fractional"),
        pytest.param("1e3", id="exponential"),
        pytest.param("1, 2", id="joined-conflicting"),
        pytest.param("1,", id="joined-trailing-empty"),
        pytest.param(",1", id="joined-leading-empty"),
        pytest.param("10,,10", id="joined-empty-part"),
        pytest.param("10, abc", id="joined-invalid"),
        pytest.param("\u0661\u0662", id="unicode-digits"),
        pytest.param("9007199254740992", id="above-max-safe-integer"),
        pytest.param("0" * 32 + str(1 << 53), id="leading-zero-above-max-safe-integer"),
        pytest.param("1" * 257, id="too-many-safe-digits"),
        pytest.param("9" * 4301, id="too-many-digits"),
    ],
)
def test_response_size_is_zero_for_invalid_content_length(
    tmp_path, real_flow, mitm_ctx, content_length
):
    """response_size should tolerate invalid Content-Length without stream metadata."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": content_length})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_accepts_matching_repeated_content_length(tmp_path, real_flow, mitm_ctx):
    """Repeated matching Content-Length values should keep the advertised size."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=http.Headers([(b"content-length", b"50000"), (b"content-length", b"50000")]),
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 50000


def test_response_size_rejects_conflicting_repeated_content_length(tmp_path, real_flow, mitm_ctx):
    """Repeated conflicting Content-Length values should not be logged as a size."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=http.Headers([(b"content-length", b"50000"), (b"content-length", b"50001")]),
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_keeps_zero_streamed_bytes(tmp_path, real_flow, mitm_ctx):
    """response_size should not treat a streamed byte count of 0 as missing."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "50000", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_tracks_large_unbounded_stream_without_length(tmp_path, real_flow, mitm_ctx):
    """response_size should not become 0 for chunked large streamed responses."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 4096)

    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(body[:123])
    response_stream(flow)(body[123:])
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == len(body)


def test_error_status_logs_warning(tmp_path, real_flow, headers):
    """Response with status >= 400 writes to per-job proxy log."""
    flow = real_flow(with_response=False, host="api.example.com")
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-abc-123"

    proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(proxy_log)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/fail?api_key=secret#frag"

    flow.response = tutils.tresp(status_code=500, headers=http.Headers())

    mitm_addon.response(flow)

    assert jsonl_exists_after_flush(proxy_log)
    [entry] = read_jsonl_entries_after_flush(proxy_log)
    assert entry["message"] == "Response 500: https://api.example.com/fail"
    assert "api_key=secret" not in entry["message"]
    assert "#frag" not in entry["message"]
