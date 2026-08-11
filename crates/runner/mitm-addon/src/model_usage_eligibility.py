"""Model-provider request eligibility across mitmproxy hook phases.

Lifecycle:
- Request handling classifies a candidate from the stable original request and
  keeps it local while firewall auth resolves.
- Successful provider continuation records the candidate on the flow. HTTP
  candidates are active immediately; WebSocket candidates remain pending.
- Response-header handling activates a pending WebSocket candidate only after
  validating the provider's 101 upgrade response.
- Model response parsers, WebSocket extraction, and terminal reporting read the
  activated protocol through this module.
- Terminal flow cleanup releases all state owned here.

The private metadata keys intentionally stay in this module. Other modules use
the transition and read APIs so candidacy cannot be mistaken for activation.
"""

from typing import Literal, NamedTuple

from mitmproxy import http

import flow_metadata
from runtime_url_parsing import split_runtime_url

type ModelUsageProtocol = Literal[
    "anthropic_messages",
    "openai_chat_completions",
    "openai_responses",
]
type ModelUsageTransport = Literal["http", "websocket"]

_PROVIDER_REQUEST = "_model_usage_provider_request"
_WEBSOCKET_ACTIVE = "_model_usage_websocket_active"


class ModelUsageRequest(NamedTuple):
    protocol: ModelUsageProtocol
    transport: ModelUsageTransport


def classify_request_candidate(
    flow: http.HTTPFlow,
    *,
    websocket_upgrade_request: bool,
) -> ModelUsageRequest | None:
    """Return the supported model operation represented by the request."""
    request_target = flow_metadata.original_url(flow.metadata) or flow.request.path
    request_path = split_runtime_url(request_target).path.rstrip("/")
    request_method = flow.request.method.upper()

    if request_method == "POST":
        if request_path.endswith("/chat/completions"):
            return ModelUsageRequest("openai_chat_completions", "http")
        if request_path.endswith("/responses"):
            return ModelUsageRequest("openai_responses", "http")
        if request_path.endswith("/messages"):
            return ModelUsageRequest("anthropic_messages", "http")
        return None

    if (
        request_method == "GET"
        and websocket_upgrade_request
        and request_path.endswith("/responses")
    ):
        return ModelUsageRequest("openai_responses", "websocket")
    return None


def record_provider_continuation(
    flow: http.HTTPFlow,
    candidate: ModelUsageRequest | None,
) -> None:
    """Record a supported request only after auth confirms provider continuation."""
    if candidate is not None:
        flow.metadata[_PROVIDER_REQUEST] = candidate


def activate_confirmed_websocket(flow: http.HTTPFlow) -> None:
    """Activate a provider-confirmed WebSocket request after its valid 101 response."""
    candidate = flow.metadata.get(_PROVIDER_REQUEST)
    if isinstance(candidate, ModelUsageRequest) and candidate.transport == "websocket":
        flow.metadata[_WEBSOCKET_ACTIVE] = True


def activated_request(flow: http.HTTPFlow) -> ModelUsageRequest | None:
    """Return the provider-confirmed request when model usage is active."""
    candidate = flow.metadata.get(_PROVIDER_REQUEST)
    if not isinstance(candidate, ModelUsageRequest):
        return None
    if candidate.transport == "http" or flow.metadata.get(_WEBSOCKET_ACTIVE) is True:
        return candidate
    return None


def activated_protocol(flow: http.HTTPFlow) -> ModelUsageProtocol | None:
    """Return the single protocol selected for active model usage consumers."""
    request = activated_request(flow)
    return request.protocol if request is not None else None


def is_websocket_active(flow: http.HTTPFlow) -> bool:
    """Return whether a confirmed model-provider WebSocket owns terminal usage."""
    request = activated_request(flow)
    return request is not None and request.transport == "websocket"


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release provider-continuation and WebSocket activation state."""
    flow.metadata.pop(_PROVIDER_REQUEST, None)
    flow.metadata.pop(_WEBSOCKET_ACTIVE, None)
