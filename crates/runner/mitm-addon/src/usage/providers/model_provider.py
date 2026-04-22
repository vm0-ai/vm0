"""Model-provider billing entry point.

Extracts Anthropic token counts already accumulated by the addon-side
SSE / JSON extractor (stored in ``flow.metadata["model_provider_usage"]``) and
forwards them to the platform ``/api/webhooks/agent/usage`` endpoint.
"""

from mitmproxy import http

from auth import get_api_url
from logging_utils import log_proxy_entry

from ..webhook import _enqueue_webhook


def report_model_provider_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Enqueue extracted token usage for model-provider responses if available."""
    firewall_name = flow.metadata.get("firewall_name", "")
    if not (firewall_name.startswith("model-provider:") and run_id):
        return
    if not flow.metadata.get("firewall_billable", False):
        return
    usage = flow.metadata.get("model_provider_usage")
    if not usage:
        return
    # Fall back to flow.id when the upstream response did not carry an `id`
    # field (non-Anthropic-shaped providers, malformed responses).  Without a
    # stable per-flow key the server side cannot deduplicate retries, which
    # would double-charge.  flow.id is unique per flow and stable across
    # retries of the usage webhook (the usage dict is copied once in
    # _enqueue_webhook and reused).
    if not usage.get("message_id"):
        usage["message_id"] = flow.id
    sandbox_token = flow.metadata.get("vm_sandbox_token", "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage: missing sandbox_token or api_url",
            type="usage",
        )
        return
    url = f"{api_url}/api/webhooks/agent/usage"
    _enqueue_webhook(
        url,
        sandbox_token,
        {"runId": run_id, "usage": usage},
        proxy_log_path,
        "usage",
    )
