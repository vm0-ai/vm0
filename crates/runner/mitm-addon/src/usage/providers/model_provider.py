"""Model-provider billing entry point.

Buffers token counts already normalized by an addon-side provider extractor
(stored in ``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]``) for aggregate upload to
the platform ``/api/webhooks/agent/usage-event`` endpoint.

Model-provider usage is intentionally reported only for platform-billable
flows. ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` comes from the web layer's
``billableFirewalls`` list; when it is false, the run is using BYO provider
credentials or another non-platform-billable path and must not charge platform
credits. The same flag gates incremental usage extraction before this reporter
runs.
"""

import uuid
from typing import TypeGuard

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from auth import get_api_url
from logging_utils import log_proxy_entry

from ..buffer import UsageEvent, buffer_usage_events
from ..idempotency import USAGE_EVENT_NAMESPACE_MODEL, encode_uuid_name
from ..model_tokens import MODEL_USAGE_CATEGORIES

MODEL_USAGE_KIND = "model"


def report_model_provider_usage(flow: http.HTTPFlow, run_id: str) -> bool:
    """Buffer extracted token usage for model-provider responses if available.

    Accepted reporting requires all universal gates to pass:

    - ``firewall_name`` starts with ``model-provider:``.
    - ``run_id`` is non-empty.
    - ``firewall_billable`` is truthy; false is the BYO-key /
      non-platform-billable path.
    - ``model_provider_usage`` is a non-empty dict.
    - At least one ``MODEL_USAGE_CATEGORIES`` value has a positive integer
      quantity.
    - ``vm_sandbox_token`` and ``get_api_url()`` are both non-empty.

    Returns whether usage was accepted into the reporting path. All failed
    gates are silent by design except missing sandbox token or API URL, which
    writes a proxy warning because that indicates an environment/reporting setup
    problem.
    """
    firewall_name = flow.metadata.get(metadata_keys.FIREWALL_NAME, "")
    if not (firewall_name.startswith("model-provider:") and run_id):
        return False
    if not flow.metadata.get(metadata_keys.FIREWALL_BILLABLE, False):
        return False
    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if not usage or not isinstance(usage, dict):
        return False
    message_id = _string_or_none(usage.get("message_id")) or flow.id
    provider = (
        _string_or_none(flow.metadata.get(metadata_keys.MODEL_USAGE_PROVIDER))
        or _string_or_none(usage.get("model"))
        or "unknown"
    )
    events = _build_usage_events(run_id, message_id, provider, usage)
    if not events:
        return False
    sandbox_token = flow.metadata.get(metadata_keys.VM_SANDBOX_AUTH_KEY, "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage event: missing sandbox_token or api_url",
            type="usage_event",
        )
        return False
    url = f"{api_url}/api/webhooks/agent/usage-event"
    buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
    )
    return True


def _build_usage_events(
    run_id: str, message_id: str, provider: str, usage: dict
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
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
            encode_uuid_name((run_id, message_id, category)),
        )
    )


def _is_positive_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _string_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value
