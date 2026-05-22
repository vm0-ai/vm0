# mitmproxy Addon Testing Guide

## Overview

The mitmproxy addon (`crates/runner/mitm-addon/`) is a Python module that intercepts HTTPS requests inside sandboxes. Tests live in `tests/` and use pytest.

## Running Tests

```bash
cd crates/runner/mitm-addon

# All tests
pytest tests/

# Specific file
pytest tests/test_handlers.py

# Specific test
pytest tests/test_handlers.py::TestRequestHandler::test_denied_flow_returns_403

# Verbose
pytest -v tests/
```

Pre-commit hooks run `pytest` on staged Python files in the addon.

## Test Files

| File | Tests |
|------|-------|
| `test_handlers.py` | Request routing, service auth, cache invalidation |
| `test_registry.py` | Registry loading, caching, file watching |
| `test_matching_patterns.py` | Low-level firewall URL, host, path, and base matching |
| `test_firewall_matching.py` | Raw firewall request matching and network policy behavior |
| `test_compiled_firewall_matching.py` | Compiled firewall matcher parity and edge cases |
| `test_firewall_auth.py` | Firewall auth header resolution, fetching, forwarding, and cleanup |
| `test_auth_base_forwarder.py` | Low-level auth.base forwarding, header filtering, and cleanup |
| `test_firewall_rewrite.py` | Firewall auth URL rewrite and query injection |
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
