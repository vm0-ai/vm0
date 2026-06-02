# mitmproxy Addon Testing Guide

## Overview

The mitmproxy addon (`crates/runner/mitm-addon/`) is a Python module that intercepts HTTPS requests inside sandboxes. Tests live in `tests/` and use pytest.

## Running Tests

```bash
cd crates/runner/mitm-addon

# All tests
pytest tests/

# Specific file
pytest tests/test_request_handler_passthrough.py

# Specific test
pytest tests/test_request_handler_passthrough.py::test_allowed_domain_passes_through

# Verbose
pytest -v tests/
```

Pre-commit hooks run `pytest` on staged Python files in the addon.

## Test Files

| File | Tests |
|------|-------|
| `test_addon_configuration.py` | Addon option registration and configuration updates |
| `test_request_handler_passthrough.py` | Request pass-through and auto-allow decisions |
| `test_request_handler_authority_validation.py` | HTTPS authority validation before firewall auth |
| `test_request_handler_firewall_dispatch.py` | Firewall dispatch and network policy decisions |
| `test_request_handler_usage_tracking.py` | Request-hook billable usage tracking lifecycle |
| `test_response_headers_handler.py` | Response-header hook stream setup |
| `test_response_handler.py` | Response hook logging, cleanup, and cache invalidation |
| `test_error_handler.py` | Error hook logging and usage cleanup |
| `test_connection_hooks.py` | Done, TLS, TCP, and TCP logging hooks |
| `test_registry.py` | Registry loading, caching, file watching |
| `test_matching_patterns.py` | Low-level firewall URL, host, path, and base matching |
| `test_firewall_matching.py` | Raw firewall request matching and network policy behavior |
| `test_compiled_firewall_matching.py` | Compiled firewall matcher parity and edge cases |
| `test_firewall_auth.py` | Firewall auth header resolution, fetching, forwarding, and cleanup |
| `test_auth_base_forwarder.py` | Low-level auth.base forwarding, header filtering, and cleanup |
| `test_firewall_rewrite.py` | Firewall auth URL rewrite and forwarding behavior |
| `test_auth_query_injection.py` | Firewall auth query injection and query rewrite behavior |
| `test_url_utils.py` | URL reconstruction and rewrite utility cases |
| `test_auth_cache.py` | Firewall auth cache behavior |
| `test_anthropic_messages.py` | Anthropic Messages usage extraction |
| `test_openai_responses_sse.py` | OpenAI Responses SSE usage extraction |
| `test_response_streaming.py` | Response streaming parser setup |
| `test_model_provider_response_usage.py` | Model provider JSON response usage pipeline |
| `test_model_provider_stream_usage.py` | Model provider SSE and WebSocket usage pipeline |
| `test_model_provider_usage.py` | Model provider usage reporter |
| `test_connector_usage.py` | Connector usage reporter and stream-path detection |
| `test_usage_idempotency.py` | Usage event idempotency key helpers |
| `test_usage_reporting_idempotency.py` | Hook-level usage reporting idempotency |
| `test_webhook.py` | Usage webhook delivery |
| `test_counters.py` | Usage pending counters |
| `test_utils.py` | Utility functions |

## Patterns

### Fixtures (conftest.py)

Shared test data via pytest fixtures:

```python
@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file."""
    registry = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "sandboxToken": "tok-xyz",
                "networkLogPath": str(tmp_path / "network.jsonl"),
            },
        },
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path
```

### Real HTTP Flows

Use the shared `real_flow` fixture when a test needs an HTTP flow. It builds a
real `mitmproxy.http.HTTPFlow` with real request, response, headers, and
metadata semantics, while still letting the test seed metadata for later hook
phases:

```python
def test_firewall_response_logs_context(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=True, host="api.github.com", path="/repos")
    flow.metadata.update(
        {
            "vm_run_id": "run-abc-123",
            "vm_network_log_path": str(tmp_path / "network.jsonl"),
            "original_url": "https://api.github.com/repos",
            "firewall_action": "ALLOW",
        }
    )

    with mitm_ctx():
        mitm_addon.response(flow)
```

Do not hand-build `MagicMock` HTTP flows for addon hook tests. Mocks and stubs
are still appropriate at real external boundaries such as `mitmproxy.ctx`,
external HTTP clients, or protocol objects that mitmproxy does not expose
through test constructors.

### Module State Reset

The addon uses module-level caches. Reset between tests:

```python
import pytest
import registry

@pytest.fixture(autouse=True)
def _reset_module_state():
    registry.reset_cache_for_tests()
    yield
```

### Mocking with patch

Patch at real external boundaries. For example, request hook tests can use the
shared `fake_firewall_headers` fixture to stub the auth-service boundary while
still running the real dispatcher and firewall handler:

```python
async def test_firewall_request_injects_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(with_response=False, host="api.github.com", path="/repos")

    with (
        mitm_ctx(registry_path=str(reg_path)),
        fake_firewall_headers(headers={"Authorization": "Bearer real-token"}),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers["Authorization"] == "Bearer real-token"
    assert flow.metadata["firewall_action"] == "ALLOW"
```

Avoid patching internal handlers only to prove they were called. Assert the flow
state, response, log entry, or other observable behavior produced by the real
hook path.

### Asserting Flow State

Check flow metadata and response after handler execution:

```python
# Service auth injected
assert flow.request.headers["Authorization"] == "Bearer real-token"
assert flow.metadata["firewall_action"] == "ALLOW"
assert flow.metadata["firewall_base"] == "https://api.github.com"
```

### Shared Flow Metadata Keys

Shared `flow.metadata` contract keys used across addon modules live in
`src/flow_metadata_keys.py`. Tests may import those constants when seeding
internal metadata for later hook phases. Keep externally visible log or schema
field assertions as string literals so tests still catch accidental output key
changes.

## What to Test

- **URL matching**: `match_service()` with various URLs, path boundaries
- **Request routing**: correct handler called based on registry state
- **Cache behavior**: token caching, expiry, invalidation on 401
- **Registry loading**: valid JSON, missing file, cache refresh

## What NOT to Test

- Real mitmproxy interception (requires running proxy)
- Real HTTP calls to auth endpoint (mock with `patch`)
- TLS certificate handling (mitmproxy internals)
