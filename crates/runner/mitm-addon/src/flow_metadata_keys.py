"""Shared ``flow.metadata`` keys used across mitm addon modules."""

from typing import Final

# Run and request context
VM_RUN_ID: Final = "vm_run_id"
VM_NETWORK_LOG_PATH: Final = "vm_network_log_path"
VM_PROXY_LOG_PATH: Final = "vm_proxy_log_path"
VM_SANDBOX_AUTH_KEY: Final = "vm_sandbox_token"
ORIGINAL_URL: Final = "original_url"
CAPTURE_BODY: Final = "capture_body"
CLI_AGENT_TYPE: Final = "cli_agent_type"

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
