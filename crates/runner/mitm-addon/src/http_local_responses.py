"""Local HTTP response construction for mitm addon request hook outcomes."""

import json
import urllib.parse
from typing import Final

from mitmproxy import http

import builtin_host_policy
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_network_log
import matching
import registry
from logging_utils import log_proxy_entry
from runtime_url_parsing import split_runtime_url, strip_url_query_and_fragment
from url_utils import AuthorityValidationError

_BUILTIN_HOST_POLICY_DENIED_ERROR: Final = "builtin_host_policy_denied"
_AMBIGUOUS_CONNECTOR_ROUTE_ERROR: Final = "ambiguous_connector_route"
_STALE_TLS_ADMISSION_ERROR: Final = "stale_tls_admission"
_UPSTREAM_DESTINATION_UNBOUND_ERROR: Final = "upstream_destination_unbound"
_HTTP_STATUS_CONFLICT = 409


def _diagnostic_url_without_query_or_fragment(original_url: str) -> str:
    retained_url = strip_url_query_and_fragment(original_url)
    parts = split_runtime_url(retained_url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def block_authority_validation_error(
    flow: http.HTTPFlow,
    error: AuthorityValidationError,
) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    flow.metadata[metadata_keys.ORIGINAL_URL] = error.fallback_url
    http_network_log.set_target_from_url(flow, error.fallback_url)
    flow_metadata.set_firewall_decision(flow.metadata, "DENY", error=error.reason)

    log_proxy_entry(
        proxy_log_path,
        "warn",
        error.message,
        type="authority_validation",
        reason=error.reason,
        sni=error.sni,
        request_host=error.request_host,
        host_header=error.host_header,
        request_port=error.request_port,
    )

    flow.response = http.Response.make(
        403,
        json.dumps(
            {
                "error": error.reason,
                "message": error.message,
                "sni": error.sni,
                "request_host": error.request_host,
                "host_header": error.host_header,
                "request_port": error.request_port,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


def block_registry_unavailable(
    flow: http.HTTPFlow,
    unavailable: registry.RegistryUnavailable,
) -> None:
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error="registry_unavailable",
    )
    flow.response = http.Response.make(
        503,
        json.dumps(
            {
                "error": "registry_unavailable",
                "message": "Proxy registry is unavailable",
                "reason": unavailable.reason,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


def block_invalid_registry_vm(
    flow: http.HTTPFlow,
    invalid_vm: registry.InvalidVmEntry,
) -> None:
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error="invalid_registry_vm",
    )
    flow.response = http.Response.make(
        503,
        json.dumps(
            {
                "error": "invalid_registry_vm",
                "message": invalid_vm.message,
                "reason": invalid_vm.reason,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


def block_stale_tls_admission(flow: http.HTTPFlow, *, reason: str) -> None:
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_STALE_TLS_ADMISSION_ERROR,
    )
    flow.response = http.Response.make(
        503,
        json.dumps(
            {
                "error": _STALE_TLS_ADMISSION_ERROR,
                "message": (
                    "Request blocked: TLS admission is no longer backed by a valid "
                    "proxy registry VM"
                ),
                "reason": reason,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


def block_upstream_destination_unbound(
    flow: http.HTTPFlow,
    *,
    reason: str,
    server_address: object,
    diagnostics: dict[str, object],
) -> None:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: upstream destination is not bound to the trusted authority",
        type="upstream_destination_binding",
        reason=reason,
        trusted_host=trusted_host,
        request_host=flow.request.host,
        request_port=flow.request.port,
        server_address=server_address,
        diagnostics=diagnostics,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_UPSTREAM_DESTINATION_UNBOUND_ERROR,
    )
    body: dict[str, object] = {
        "error": _UPSTREAM_DESTINATION_UNBOUND_ERROR,
        "message": "Request blocked: upstream destination is not bound to trusted authority",
        "reason": reason,
        "trusted_host": trusted_host,
        "request_host": flow.request.host,
        "request_port": flow.request.port,
    }
    firewall_base = flow_metadata.firewall_base(flow.metadata)
    if firewall_base:
        body["base"] = firewall_base
    flow.response = http.Response.make(
        403,
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )


def block_builtin_host_policy_denied(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    error: builtin_host_policy.BuiltinRuntimeHostPolicyError,
    upstream_endpoint: str,
) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: builtin firewall host policy rejected credential injection",
        type="builtin_host_policy",
        name=allow.name,
        reason=error.reason,
        trusted_host=trusted_host,
        request_port=flow.request.port,
        upstream_endpoint=upstream_endpoint,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_BUILTIN_HOST_POLICY_DENIED_ERROR,
    )
    body: dict[str, object] = {
        "error": _BUILTIN_HOST_POLICY_DENIED_ERROR,
        "message": "Request blocked: builtin firewall host policy rejected credential injection",
        "reason": error.reason,
        "name": allow.name,
        "trusted_host": trusted_host,
        "request_port": flow.request.port,
    }
    firewall_base = flow_metadata.firewall_base(flow.metadata)
    if firewall_base:
        body["base"] = firewall_base
    flow.response = http.Response.make(
        403,
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )


def set_firewall_block_response(flow: http.HTTPFlow, result: matching.FirewallBlock) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    if result.reason == "malformed_network_policy":
        block_message = "malformed network policy"
        response_message = "Request blocked: malformed network policy"
    elif result.reason == "unsafe_path":
        block_message = "unsafe path"
        response_message = "Request blocked: unsafe path"
    else:
        block_message = "no matching permission"
        response_message = "Request blocked: no matching permission rule"
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Firewall {result.name}: {block_message} for {result.method} {result.path}",
        type="firewall_block",
        name=result.name,
        reason=result.reason,
    )
    flow_metadata.set_firewall_decision(flow.metadata, "DENY")
    flow.metadata[metadata_keys.FIREWALL_BASE] = result.base
    flow.metadata[metadata_keys.FIREWALL_NAME] = result.name
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = (
        result.permissions[0] if len(result.permissions) == 1 else ""
    )
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    diagnostic_url = _diagnostic_url_without_query_or_fragment(original_url)
    error_body = json.dumps(
        {
            "error": "permission_denied",
            "message": response_message,
            "method": result.method,
            "path": result.path,
            "url": diagnostic_url,
            "name": result.name,
            "permissions": list(result.permissions),
            "reason": result.reason,
            "base": result.base,
        }
    )
    flow.response = http.Response.make(
        403,
        error_body.encode(),
        {"Content-Type": "application/json"},
    )


def set_firewall_ambiguous_response(
    flow: http.HTTPFlow,
    result: matching.FirewallAmbiguous,
) -> None:
    """Return a local conflict before any connector credential is selected."""
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    candidates = list(result.candidates)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Ambiguous connector route for {result.method} {result.path}",
        type="firewall_ambiguous",
        reason=result.reason,
        candidates=candidates,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "DENY",
        error=_AMBIGUOUS_CONNECTOR_ROUTE_ERROR,
    )
    flow.metadata[metadata_keys.CONNECTOR_ROUTE_REASON] = result.reason
    flow.metadata[metadata_keys.CONNECTOR_ROUTE_CANDIDATES] = candidates
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    diagnostic_url = _diagnostic_url_without_query_or_fragment(original_url)
    flow.response = http.Response.make(
        _HTTP_STATUS_CONFLICT,
        json.dumps(
            {
                "error": _AMBIGUOUS_CONNECTOR_ROUTE_ERROR,
                "message": "Request blocked: connector route requires explicit intent",
                "reason": result.reason,
                "method": result.method,
                "path": result.path,
                "url": diagnostic_url,
                "candidates": candidates,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


def block_public_destination_denied(
    flow: http.HTTPFlow,
    *,
    name: str,
    base: str,
    destination_host: str,
    trusted_authority_host: str,
    reason: str,
    send_response: bool = True,
) -> None:
    """Record a public-destination denial and optionally install its local response.

    Both modes disable request streaming, record the DENY decision with the
    ``unsafe_public_destination`` error and firewall base/name, and emit the redacted
    public-destination proxy warning. When ``send_response`` is ``True``, this also installs
    the JSON HTTP 403 response. When it is ``False``, the function leaves ``flow.response``
    unchanged and does not terminate the flow; the caller must terminate it and prevent
    later request dispatch.
    """
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    flow.request.stream = False
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "DENY",
        error="unsafe_public_destination",
    )
    flow.metadata[metadata_keys.FIREWALL_BASE] = base
    flow.metadata[metadata_keys.FIREWALL_NAME] = name

    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: publicDestination resolved to a non-public destination",
        type="public_destination",
        name=name,
        firewall_base=base,
        destination_host=destination_host,
        trusted_authority_host=trusted_authority_host,
        reason=reason,
    )

    error_body = json.dumps(
        {
            "error": "unsafe_public_destination",
            "message": "Request blocked: publicDestination resolved to a non-public destination",
            "name": name,
            "base": base,
            "destination_host": destination_host,
            "trusted_authority_host": trusted_authority_host,
            "reason": reason,
        }
    )
    if send_response:
        flow.response = http.Response.make(
            403,
            error_body.encode(),
            {"Content-Type": "application/json"},
        )
