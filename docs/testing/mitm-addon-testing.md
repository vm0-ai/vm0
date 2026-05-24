# mitmproxy Addon Testing Guide

## Overview

The mitmproxy addon (`crates/runner/mitm-addon/`) is a Python module that intercepts HTTPS requests inside sandboxes. Tests live in `tests/` and use pytest.

## Running Tests

```bash
cd crates/runner/mitm-addon

# All tests
pytest tests/

# Specific file
pytest tests/test_request_handler.py

# Specific test
pytest tests/test_request_handler.py::TestRequestHandler::test_allowed_domain_passes_through

# Verbose
pytest -v tests/
```

Pre-commit hooks run `pytest` on staged Python files in the addon.

## Test Files

| File | Tests |
|------|-------|
| `test_addon_configuration.py` | Addon option registration and configuration updates |
| `test_request_handler.py` | Request routing, service auth, firewall decisions |
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
| `test_usage_reporting.py` | Response usage extraction and reporting pipeline |
| `test_model_provider_usage.py` | Model provider usage reporter |
| `test_connector_usage.py` | Connector usage reporter and stream-path detection |
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

### Mock HTTP Flows

Build mock mitmproxy flow objects for testing:

```python
def _make_http_flow(client_ip="10.200.0.1", host="example.com", port=443, path="/"):
    flow = MagicMock()
    flow.client_conn.peername = (client_ip, 12345)
    flow.request.pretty_host = host
    flow.request.port = port
    flow.request.path = path
    flow.request.pretty_url = f"https://{host}{path}"
    flow.request.method = "GET"
    flow.request.content = b""
    flow.request.headers = {}
    flow.metadata = {}
    flow.response = None
    return flow
```

### Module State Reset

The addon uses module-level caches. Reset between tests:

```python
import registry

def _reset():
    mitm_addon._request_start_times.clear()
    registry.reset_cache_for_tests()

class TestRequestHandler:
    def setup_method(self):
        _reset()
```

### Mocking with patch

Use `unittest.mock.patch` for module-level functions:

```python
from unittest.mock import MagicMock, patch

def test_service_match_calls_handler(self, registry_file):
    flow = _make_http_flow(host="api.github.com", path="/repos")

    with (
        patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
        patch.object(mitm_addon, "handle_service_request") as mock_handler,
    ):
        mitm_addon.request(flow)

    mock_handler.assert_called_once()
    call_args = mock_handler.call_args
    assert call_args[0][0] is flow
    assert call_args[0][1]["base"] == "https://api.github.com"
```

### Asserting Flow State

Check flow metadata and response after handler execution:

```python
# Service auth injected
assert flow.request.headers["Authorization"] == "Bearer real-token"
assert flow.metadata["firewall_action"] == "ALLOW"
assert flow.metadata["service_base"] == "https://api.github.com"
```

## What to Test

- **URL matching**: `match_service()` with various URLs, path boundaries
- **Request routing**: correct handler called based on registry state
- **Cache behavior**: token caching, expiry, invalidation on 401
- **Registry loading**: valid JSON, missing file, cache refresh

## What NOT to Test

- Real mitmproxy interception (requires running proxy)
- Real HTTP calls to auth endpoint (mock with `patch`)
- TLS certificate handling (mitmproxy internals)
