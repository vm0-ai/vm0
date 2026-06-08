"""Shared ``flow.metadata`` keys used across mitm addon modules.

This module is the public cross-module registry for metadata keys that flow
between mitmproxy hooks and addon packages. Hook-local private markers may
exist in their owning modules, but they are not part of this shared contract.
When adding a shared metadata key, add its ownership and lifecycle notes here.

Request context
---------------
- ``VM_RUN_ID``: ``str`` copied from registry VM info by ``request()`` and
  ``tcp_start()``. Read by HTTP, TCP, proxy logging, and usage reporting.
- ``VM_NETWORK_LOG_PATH``: ``str`` copied from registry VM info. Read by HTTP
  and TCP log writers; empty strings skip network-log writes.
- ``VM_PROXY_LOG_PATH``: ``str`` copied from registry VM info. Read by proxy
  warnings, usage reporting, and auth/streaming diagnostics.
- ``VM_SANDBOX_AUTH_KEY``: ``str`` sandbox token copied from registry VM info.
  Read by usage webhook reporters.
- ``ORIGINAL_URL``: absolute URL written by ``request()`` from trusted
  authority, or from the authority-validation fallback URL on local denial.
  Read by response/error logging and connector billing.
- ``NETWORK_LOG_TARGET``: ``dict`` with ``url``, ``host``, and ``port`` from
  trusted authority or authority-validation fallback URL. Read by network-log
  entry construction.
- ``CAPTURE_BODY``: ``bool`` copied from registry VM info. Read by
  ``response()`` to decide whether to add request/response bodies.
- ``SUPPRESS_REQUEST_BODY_CAPTURE``: ``bool`` written by auth.base request-size
  handling. Read by body capture to mark oversized request bodies truncated.
- ``CLI_AGENT_TYPE``: ``str`` copied from registry VM info, defaulting to
  ``"claude-code"``. Read by model-provider usage protocol selection.
- ``BROWSER_USER_AGENT``: ``bool`` written by ``request()`` for browser-looking
  user agents. Read by request dispatch to skip auth mutation for that flow and
  by network-log entry construction.

Timing context
--------------
- ``HTTP_REQUEST_START_MONOTONIC``: ``float`` from ``time.monotonic()``,
  written by ``request()`` after registered-VM lookup. Popped by ``response()``
  or ``error()`` when computing HTTP latency, and removed on request failures.
- ``TCP_START_MONOTONIC``: ``float`` from ``time.monotonic()``, written by
  ``tcp_start()``. Read by TCP end/error logging; it is not popped.

Firewall and auth context
-------------------------
- ``FIREWALL_BASE``: ``str`` matched firewall base. Written by firewall match,
  browser passthrough, matched firewall block, and auth paths. Read by logging,
  auth cache invalidation, usage dispatch, and local error responses.
- ``FIREWALL_API_ID``: ``str`` API id or base fallback from the matched
  firewall. Read by auth handling and 401 cache invalidation.
- ``FIREWALL_NAME``: ``str`` firewall connector/model name. Read by logging,
  model-provider gates, and connector usage dispatch.
- ``FIREWALL_PERMISSION``: ``str`` matched permission name or empty string.
  Read by logging and connector-specific billing.
- ``FIREWALL_RULE_MATCH``: ``str`` matched rule or empty string. Read by
  network-log firewall metadata.
- ``FIREWALL_PARAMS``: ``dict`` firewall params from the match. Read by
  network-log firewall metadata when it has the expected shape.
- ``FIREWALL_BILLABLE``: ``bool`` computed from runner VM billable firewall
  context for matched auth flows, or forced ``False`` for browser passthrough.
  Gates connector billing and connector response parser setup; model usage
  reporting still checks model-provider-specific gates.
- ``FIREWALL_ACTION``: ``str`` firewall decision such as ``ALLOW``, ``DENY``,
  or ``BLOCK``. Read by response/error network logging.
- ``FIREWALL_ERROR``: optional ``str`` error code for auth, forwarding, or
  registry failures. It is orthogonal to ``FIREWALL_ACTION``: an ``ALLOW``
  decision can still have an auth or forwarding error.
- ``AUTH_RESOLVED_SECRETS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_REFRESHED_CONNECTORS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_REFRESHED_SECRETS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_CACHE_HIT``: ``bool`` from successful auth resolution. Read by
  network-log firewall metadata.
- ``AUTH_URL_REWRITE``: ``bool`` written only after inline auth.base forwarding
  succeeds and sets the provider response on the flow. Read by network-log
  firewall metadata.
- ``TRUSTED_AUTHORITY_HOST``: ``str`` host from authority validation. Read by
  auth-base URL rewrite logic when reconstructing trusted request authority.

Response streaming
------------------
- ``STREAM_BUFFER``: capped ``bytearray`` written by ``responseheaders()`` via
  response streaming setup. Read by response logging, body capture, model JSON
  fallback extraction, and connector fallback parsing. Removed by stream
  cleanup after terminal hooks.
- ``STREAM_BUFFER_STATE``: ``dict`` with at least ``truncated`` and
  ``total_bytes``. Written with ``STREAM_BUFFER`` and read for response size,
  capture truncation, and connector parsing. Removed by stream cleanup.

Model-provider usage
--------------------
- ``MODEL_PROVIDER_USAGE``: ``dict`` of normalized token usage. Written by
  streaming/JSON/WebSocket extractors or fallback extraction, then read by
  model usage-event and observation reporters.
- ``MODEL_USAGE_PROVIDER``: optional ``str`` model id from registry VM info.
  Read by model-provider usage observability and reported-model selection.
- ``MODEL_JSON_USAGE_FINALIZED``: ``bool`` written when JSON usage finalization
  ran. Read by ``response()`` to skip legacy fallback JSON extraction.

Connector usage and parser state
--------------------------------
- ``X_NDJSON_STATE``: ``dict`` owned by the X connector NDJSON parser. Written
  when a streaming X response parser is registered, read by X billing, and
  also read by ``error()`` to report partial stream usage.
- ``X_JSON_STATE``: ``dict`` owned by the X connector JSON parser. Written by
  connector parser finalization before normal response billing, then read by X
  billing instead of the capped stream-buffer fallback.
"""

from typing import Final

# Run and request context
VM_RUN_ID: Final = "vm_run_id"
VM_NETWORK_LOG_PATH: Final = "vm_network_log_path"
VM_PROXY_LOG_PATH: Final = "vm_proxy_log_path"
VM_SANDBOX_AUTH_KEY: Final = "vm_sandbox_token"
ORIGINAL_URL: Final = "original_url"
NETWORK_LOG_TARGET: Final = "network_log_target"
CAPTURE_BODY: Final = "capture_body"
SUPPRESS_REQUEST_BODY_CAPTURE: Final = "suppress_request_body_capture"
CLI_AGENT_TYPE: Final = "cli_agent_type"
BROWSER_USER_AGENT: Final = "browser_user_agent"

# Timing metadata
HTTP_REQUEST_START_MONOTONIC: Final = "http_request_start_monotonic"
TCP_START_MONOTONIC: Final = "tcp_start_monotonic"

# Firewall and auth metadata
FIREWALL_BASE: Final = "firewall_base"
FIREWALL_API_ID: Final = "firewall_api_id"
FIREWALL_NAME: Final = "firewall_name"
FIREWALL_PERMISSION: Final = "firewall_permission"
FIREWALL_RULE_MATCH: Final = "firewall_rule_match"
FIREWALL_PARAMS: Final = "firewall_params"
FIREWALL_BILLABLE: Final = "firewall_billable"
FIREWALL_ACTION: Final = "firewall_action"
FIREWALL_ERROR: Final = "firewall_error"
AUTH_RESOLVED_SECRETS: Final = "auth_resolved_secrets"
AUTH_REFRESHED_CONNECTORS: Final = "auth_refreshed_connectors"
AUTH_REFRESHED_SECRETS: Final = "auth_refreshed_secrets"
AUTH_CACHE_HIT: Final = "auth_cache_hit"
AUTH_URL_REWRITE: Final = "auth_url_rewrite"
TRUSTED_AUTHORITY_HOST: Final = "trusted_authority_host"

# Usage and streaming metadata
MODEL_PROVIDER_USAGE: Final = "model_provider_usage"
MODEL_USAGE_PROVIDER: Final = "model_usage_provider"
MODEL_JSON_USAGE_FINALIZED: Final = "_model_json_usage_finalized"
STREAM_BUFFER: Final = "stream_buffer"
STREAM_BUFFER_STATE: Final = "stream_buffer_state"
X_NDJSON_STATE: Final = "x_ndjson_state"
X_JSON_STATE: Final = "x_json_state"
