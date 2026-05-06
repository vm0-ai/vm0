"""Model-provider billing entry point.

Forwards token counts already normalized by an addon-side provider extractor
(stored in ``flow.metadata["model_provider_usage"]``) to the platform
``/api/webhooks/agent/usage-event`` endpoint.
"""

import uuid

from mitmproxy import http

from auth import get_api_url
from logging_utils import log_proxy_entry

from ..model_tokens import MODEL_USAGE_CATEGORIES
from ..namespaces import USAGE_EVENT_NAMESPACE_MODEL
from ..webhook import _enqueue_webhook

MODEL_USAGE_KIND = "model"


def report_model_provider_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Enqueue extracted token usage for model-provider responses if available."""
    firewall_name = flow.metadata.get("firewall_name", "")
    if not (firewall_name.startswith("model-provider:") and run_id):
        return
    if not flow.metadata.get("firewall_billable", False):
        return
    usage = flow.metadata.get("model_provider_usage")
    if not usage or not isinstance(usage, dict):
        return
    message_id = _string_or_none(usage.get("message_id")) or flow.id
    provider = (
        _string_or_none(flow.metadata.get("model_usage_provider"))
        or _string_or_none(usage.get("model"))
        or "unknown"
    )
    events = _build_usage_events(run_id, message_id, provider, usage)
    if not events:
        return
    sandbox_token = flow.metadata.get("vm_sandbox_token", "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage event: missing sandbox_token or api_url",
            type="usage_event",
        )
        return
    url = f"{api_url}/api/webhooks/agent/usage-event"
    _enqueue_webhook(
        url,
        sandbox_token,
        {"runId": run_id, "events": events},
        proxy_log_path,
        "usage_event",
    )


def _build_usage_events(run_id: str, message_id: str, provider: str, usage: dict) -> list[dict]:
    events = []
    for category in MODEL_USAGE_CATEGORIES:
        quantity = usage.get(category)
        if not _is_positive_int(quantity):
            continue
        events.append(
            {
                "idempotencyKey": _derive_idempotency_key(run_id, message_id, category),
                "kind": MODEL_USAGE_KIND,
                "provider": provider,
                "category": category,
                "quantity": quantity,
            }
        )
    return events


def _derive_idempotency_key(run_id: str, message_id: str, category: str) -> str:
    return str(
        uuid.uuid5(
            USAGE_EVENT_NAMESPACE_MODEL,
            _encode_uuid_name((run_id, message_id, category)),
        )
    )


def _encode_uuid_name(parts: tuple[str, ...]) -> str:
    return "\0".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _string_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value
