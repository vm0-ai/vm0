# mitmproxy Addon Testing Guide

## Overview

The mitmproxy addon (`crates/runner/mitm-addon/`) is a Python module that intercepts HTTPS requests inside sandboxes. Tests live in `tests/` and use pytest.

## Environment Setup

The addon uses uv for dependency management. The supported devcontainer installs
the exact uv version declared in `pyproject.toml`. In other environments, install
that version before continuing:

```bash
cd crates/runner/mitm-addon
UV_VERSION="$(
  python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["tool"]["uv"]["required-version"].removeprefix("=="))'
)"
curl --proto '=https' --tlsv1.2 -LsSf \
  "https://astral.sh/uv/$UV_VERSION/install.sh" |
  env UV_UNMANAGED_INSTALL="$HOME/.local/bin" sh
export PATH="$HOME/.local/bin:$PATH"
uv --version
```

Create or update the local environment from the committed lockfile:

```bash
cd crates/runner/mitm-addon
uv lock --check
uv sync --locked
```

`uv sync --locked` installs the development and test dependency groups into
`.venv` without changing `uv.lock`.

## Running Tests

```bash
cd crates/runner/mitm-addon

# All tests
uv run --no-sync python -m pytest tests/

# Specific file
uv run --no-sync python -m pytest tests/test_request_handler_passthrough.py

# Specific test
uv run --no-sync python -m pytest \
  tests/test_request_handler_passthrough.py::test_allowed_domain_passes_through

# Verbose
uv run --no-sync python -m pytest -v tests/
```

Run the same static checks used by CI:

```bash
uv run --no-sync ruff format --check .
uv run --no-sync ruff check .
uv run --no-sync basedpyright -p .
```

Pre-commit hooks verify the lockfile when dependency metadata changes and run
Ruff from the locked environment for staged addon Python files. Run pytest
manually before committing behavior changes.

## Updating Dependencies

Edit the dependency constraints in `pyproject.toml`, then regenerate and verify
the lockfile:

```bash
uv lock
uv sync --locked
uv lock --check
```

To deliberately refresh every dependency, use `uv lock --upgrade`. To refresh
one package and the portion of the graph it constrains, use
`uv lock --upgrade-package <package>`. Review the resolved versions and hashes
with `git diff -- uv.lock`, then run all static checks and the complete test
suite.

Commit `pyproject.toml` and `uv.lock` together. Keep the mitmproxy constraint
aligned with the standalone runtime version in `crates/runner/src/deps.rs`;
tests must not resolve a different mitmproxy version from production.

## Test Files

| File                                                    | Tests                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `test_addon_configuration.py`                           | Addon option registration and configuration updates                                                                  |
| `test_builtin_host_policy_contract.py`                  | Cross-stage malformed built-in host policy contracts                                                                 |
| `test_connection_endpoints.py`                          | Connection endpoint shape validation and IPv6 tuple normalization                                                     |
| `test_request_handler_passthrough.py`                   | Request pass-through, auto-allow, and browser user-agent passthrough decisions                                       |
| `test_request_handler_authority_validation.py`          | HTTPS authority validation before firewall auth                                                                      |
| `test_request_handler_firewall_dispatch.py`             | Core firewall dispatch, permission blocks, malformed config/policy handling, block responses, and unsafe-path blocks |
| `test_request_handler_public_destination.py`            | Request-hook public destination validation and revalidation                                                          |
| `test_request_handler_connector_diagnostics.py`         | Request-hook connector diagnostics and inactive built-in connector diagnostics                                       |
| `test_request_handler_auth_base_body.py`                | Request-hook auth-base body admission and cleanup                                                                    |
| `test_request_headers_streaming.py`                     | Requestheaders stream installation, body framing, buffering, and probe cleanup                                        |
| `test_request_headers_api_admission.py`                 | Requestheaders platform API destination admission and binding                                                        |
| `test_request_headers_connector_admission.py`           | Requestheaders connector destination admission, TLS evidence, and binding                                             |
| `test_request_headers_firewall_auth.py`                 | Requestheaders stream-safe firewall auth, connector intent, fallback, and cancellation cleanup                       |
| `test_mitmproxy_request_framing.py`                     | HTTP/2 request framing through mitmproxy's state machine and real addon hook dispatch                                 |
| `test_request_handler_usage_tracking.py`                | Request-hook billable usage tracking lifecycle                                                                       |
| `test_response_headers_handler.py`                      | Response-header hook stream setup                                                                                    |
| `test_response_handler_connector_diagnostics.py`        | Response-hook connector diagnostic replacement and streaming lifecycle                                               |
| `test_response_handler_logging.py`                      | Response-hook network/proxy logging, size accounting, and body capture                                               |
| `test_response_handler_auth_recovery.py`                | Response-hook 401 firewall-auth cache invalidation and refresh recovery                                              |
| `test_response_handler_cleanup.py`                      | Response-hook terminal request/response stream-state cleanup                                                         |
| `test_error_handler.py`                                 | Error hook logging and usage cleanup                                                                                 |
| `test_done_hook.py`                                     | Shutdown hook usage flush and executor cleanup                                                                       |
| `test_runner_usage_flush_signal.py`                     | Runner-triggered usage and JSONL flush requests                                                                      |
| `test_tls_clienthello_hook.py`                          | TLS clienthello admission behavior                                                                                   |
| `test_tcp_hooks.py`                                     | TCP start, logging, message drain, end, and error hooks                                                              |
| `test_registry_loading.py`                              | Registry loading, parsing, unavailable-state, and cache behavior                                                     |
| `test_registry_auth_cache_eviction.py`                  | Registry-driven auth-cache ownership and eviction behavior                                                           |
| `test_registry_context.py`                              | VM lookup and public compiled context API behavior                                                                   |
| `test_registry_builtin_cache.py`                        | Registry built-in firewall resolution and compiled-core cache behavior                                               |
| `test_registry_builtin_base_url_vars.py`                | Registry built-in base URL variable resolution and validation                                                        |
| `test_registry_context_state.py`                        | Registry compiled context reload, unavailable-state, and malformed-shape behavior                                    |
| `test_matching_path.py`                                 | Low-level firewall path matching                                                                                     |
| `test_matching_host.py`                                 | Low-level firewall host matching                                                                                     |
| `test_matching_path_prefix.py`                          | Low-level firewall path-prefix matching                                                                              |
| `test_matching_base_url_static.py`                      | Static firewall base URL matching and authority normalization                                                        |
| `test_matching_base_url_parameterized.py`               | Parameterized firewall base URL matching                                                                             |
| `test_matching_mixed_segments.py`                       | Mixed parameter-segment matcher regressions                                                                          |
| `test_matching_anthropic_firewall_scope.py`             | Anthropic firewall scope matching regressions                                                                        |
| `test_firewall_request_matching.py`                     | Raw firewall request matching through the compiled matcher                                                           |
| `test_firewall_request_base_matching.py`                | Request-layer firewall base URL matching through raw firewall config                                                 |
| `test_firewall_request_rel_path.py`                     | Request-layer `rel_path` propagation through raw firewall config                                                     |
| `test_firewall_network_policy_decisions.py`             | Request-layer network policy decision behavior                                                                       |
| `test_compiled_firewall_base_path_matching.py`          | Compiled firewall base path, rule path, segment boundary, and path syntax matching                                   |
| `test_compiled_firewall_host_base_matching.py`          | Compiled firewall host-parameterized base matching                                                                   |
| `test_compiled_firewall_authority_normalization.py`     | Compiled firewall runtime URL, authority, and port normalization                                                     |
| `test_compiled_firewall_idna_matching.py`               | Compiled firewall IDNA authority matching and compatibility-alias rejection                                          |
| `test_compiled_firewall_unknown_policy.py`              | Compiled firewall unknown-policy and unsafe-path behavior                                                            |
| `test_compiled_firewall_base_specificity_precedence.py` | Compiled firewall base specificity precedence                                                                        |
| `test_compiled_firewall_cross_firewall_precedence.py`   | Compiled firewall cross-firewall and permission ordering precedence                                                  |
| `test_compiled_firewall_malformed_auth.py`              | Compiled firewall malformed auth config behavior                                                                     |
| `test_compiled_firewall_malformed_base.py`              | Compiled firewall malformed base and base-scope behavior                                                             |
| `test_compiled_firewall_malformed_permissions.py`       | Compiled firewall malformed permission behavior                                                                      |
| `test_compiled_firewall_malformed_policies.py`          | Compiled firewall malformed policy and payload-shape behavior                                                        |
| `test_compiled_firewall_malformed_precedence.py`        | Compiled firewall malformed config and malformed network-policy precedence                                           |
| `test_compiled_firewall_malformed_rules.py`             | Compiled firewall malformed rule and rule-shape behavior                                                             |
| `test_compiled_firewall_permission_aggregation.py`      | Compiled firewall denied-permission aggregation and deduplication                                                    |
| `test_compiled_firewall_rule_specificity_precedence.py` | Compiled firewall rule ordering and rule specificity precedence                                                      |
| `test_firewall_auth.py`                                 | Firewall auth header resolution, fetching, forwarding, and cleanup                                                   |
| `test_auth_base_forwarder.py`                           | Low-level auth.base forwarding, header filtering, and cleanup                                                        |
| `test_firewall_rewrite_success.py`                      | Firewall auth URL rewrite success behavior                                                                           |
| `test_firewall_rewrite_forwarding.py`                   | Firewall auth URL rewrite forwarding behavior                                                                        |
| `test_firewall_rewrite_safety.py`                       | Firewall auth URL rewrite fail-closed and safety behavior                                                            |
| `test_auth_query_injection.py`                          | Firewall auth query injection and query rewrite behavior                                                             |
| `test_url_utils.py`                                     | Rewrite URL, path, query, and auth-base URL utility cases                                                            |
| `test_url_utils_trusted_authority.py`                   | Trusted request authority success and URL reconstruction                                                             |
| `test_url_utils_trusted_authority_rejection.py`         | Trusted request authority rejection matrices                                                                         |
| `test_auth_cache.py`                                    | Firewall auth cache behavior                                                                                         |
| `test_body_capture_decompression.py`                    | Capture-level body decompression integration                                                                         |
| `test_body_capture_encoding.py`                         | Body capture text detection, encoding, and UTF-8 truncation helpers                                                  |
| `test_body_capture_fields.py`                           | Ordinary request/response body capture fields                                                                        |
| `test_body_capture_headers.py`                          | Captured network-log header sanitization                                                                             |
| `test_body_capture_stream_buffer.py`                    | Body capture stream-buffer contracts                                                                                 |
| `test_body_decoding.py`                                 | Shared body decoding, streaming decode, codec limits, and decompression errors                                       |
| `test_anthropic_messages.py`                            | Anthropic Messages SSE and JSON usage extraction                                                                     |
| `test_openai_responses_event_json.py`                   | OpenAI Responses event JSON usage extraction and merge behavior                                                      |
| `test_openai_responses_json.py`                         | OpenAI Responses non-SSE JSON usage extraction                                                                       |
| `test_openai_responses_sse.py`                          | OpenAI Responses SSE usage extraction                                                                                |
| `test_response_streaming.py`                            | Response streaming parser setup                                                                                      |
| `test_model_provider_json_fallback.py`                  | Model provider buffered JSON fallback usage pipeline                                                                 |
| `test_model_provider_json_streaming.py`                 | Model provider streaming JSON response usage pipeline                                                                |
| `test_model_provider_sse_usage.py`                      | Model provider SSE usage pipeline                                                                                    |
| `test_model_provider_websocket_usage.py`                | Model provider WebSocket usage reporting and source reconciliation                                                   |
| `test_model_provider_websocket_lifecycle.py`            | Model provider WebSocket HTTP upgrade and terminal usage lifecycle                                                   |
| `test_websocket_retention.py`                           | Registered WebSocket message retention and cleanup                                                                   |
| `test_model_provider_websocket_metadata.py`             | Model provider WebSocket usage metadata parsing                                                                      |
| `test_model_provider_usage.py`                          | Model provider usage reporter                                                                                        |
| `x_connector_usage/`                                    | Direct X connector usage billing, write refinement, unparseable fallback, and skip gates                             |
| `test_connector_usage.py`                               | Connector usage reporter and stream-path detection                                                                   |
| `test_usage_idempotency.py`                             | Usage event idempotency key helpers                                                                                  |
| `test_usage_reporting_idempotency.py`                   | Hook-level usage reporting idempotency                                                                               |
| `test_webhook_delivery_admission.py`                    | Usage webhook delivery admission, capacity, pending counter, and executor fallback behavior                          |
| `test_webhook_http_delivery.py`                         | Usage webhook HTTP delivery, retry, request, and log behavior                                                        |
| `test_counters.py`                                      | Usage pending counters                                                                                               |

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
import flow_metadata_keys as metadata_keys


def test_firewall_response_logs_context(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=True, host="api.github.com", path="/repos")
    flow.metadata.update(
        {
            metadata_keys.VM_RUN_ID: "run-abc-123",
            metadata_keys.VM_NETWORK_LOG_PATH: str(tmp_path / "network.jsonl"),
            metadata_keys.ORIGINAL_URL: "https://api.github.com/repos",
            metadata_keys.FIREWALL_ACTION: "ALLOW",
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
import flow_metadata_keys as metadata_keys


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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
```

Avoid patching internal handlers only to prove they were called. Assert the flow
state, response, log entry, or other observable behavior produced by the real
hook path.

### Asserting Flow State

Check flow metadata and response after handler execution:

```python
import flow_metadata_keys as metadata_keys


# Service auth injected
assert flow.request.headers["Authorization"] == "Bearer real-token"
assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
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
