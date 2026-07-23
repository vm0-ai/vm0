"""Shared HTTP request classification contract for mitmproxy hooks.

This module owns the classification result consumed by both `requestheaders()`
and `request()`. The header hook may classify as a probe before mitmproxy has
buffered the request body. When that header-phase decision must be reused by
the request hook, it caches the classification on the current flow. When the
header hook only probed to decide whether it can handle the request early, it
restores the metadata touched by that probe path before falling through.

The request hook consumes a cached classification when present, otherwise it
performs a fresh classification. Cached classifications are scoped to a single
flow and must be popped by terminal, response/error, and final request paths so
stale decisions cannot leak into later hook handling for the same flow.
"""

from dataclasses import dataclass, field
from typing import Literal, Protocol, TypeAlias

from mitmproxy import http

import connection_endpoints
import connector_intent
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_network_log
import matching
import public_destination
import registry
import registry_firewalls
import upstream_admission
import upstream_destination_binding
from url_utils import AuthorityValidationError, get_trusted_authority, normalize_trusted_hostname

REQUEST_CLASSIFICATION_METADATA_KEY = "_request_classification"
# Metadata that the requestheaders probe path may write while using this
# classification result. Restore it when the probe is not carried forward into
# request handling.
REQUEST_HEADERS_PROBE_METADATA_KEYS = (
    metadata_keys.VM_RUN_ID,
    metadata_keys.VM_NETWORK_LOG_PATH,
    metadata_keys.VM_PROXY_LOG_PATH,
    metadata_keys.CAPTURE_BODY,
    metadata_keys.VM_SANDBOX_AUTH_KEY,
    metadata_keys.CLI_AGENT_TYPE,
    metadata_keys.BROWSER_USER_AGENT,
    metadata_keys.WEBSOCKET_UPGRADE_REQUEST,
    metadata_keys.ORIGINAL_URL,
    metadata_keys.TRUSTED_AUTHORITY_HOST,
    metadata_keys.NETWORK_LOG_TARGET,
    metadata_keys.HTTP_REQUEST_START_MONOTONIC,
)

_BROWSER_USER_AGENT_MARKERS = (
    " chrome/",
    " chromium/",
    " crios/",
    " edg/",
    " firefox/",
    " fxios/",
    " headlesschrome/",
    " opr/",
    " safari/",
)

StaleTlsAdmissionReason: TypeAlias = Literal[
    "client_ip_missing",
    "client_ip_mismatch",
    "registry_entry_missing",
    "run_id_mismatch",
]


class TlsAdmissionView(Protocol):
    """TLS admission facts captured before HTTP request classification."""

    @property
    def client_ip(self) -> str:
        raise NotImplementedError

    @property
    def run_id(self) -> str | None:
        raise NotImplementedError


@dataclass(frozen=True)
class PublicDestinationDenial:
    """Runtime publicDestination denial returned with its logging context."""

    name: str
    base: str
    trusted_authority_host: str
    destination_host: str
    reason: public_destination.DestinationDenialReason


@dataclass(frozen=True)
class NoClientIp:
    kind: Literal["no_client_ip"] = field(init=False, default="no_client_ip")


@dataclass(frozen=True)
class PassThrough:
    kind: Literal["pass_through"] = field(init=False, default="pass_through")


@dataclass(frozen=True)
class RegistryUnavailable:
    registry_unavailable: registry.RegistryUnavailable
    kind: Literal["registry_unavailable"] = field(init=False, default="registry_unavailable")


@dataclass(frozen=True)
class StaleTlsAdmission:
    stale_tls_reason: StaleTlsAdmissionReason
    kind: Literal["stale_tls_admission"] = field(init=False, default="stale_tls_admission")


@dataclass(frozen=True)
class InvalidRegistryVm:
    invalid_vm: registry.InvalidVmEntry
    kind: Literal["invalid_registry_vm"] = field(init=False, default="invalid_registry_vm")


@dataclass(frozen=True)
class AuthorityDenied:
    vm_info: dict
    authority_error: AuthorityValidationError
    kind: Literal["authority_denied"] = field(init=False, default="authority_denied")


@dataclass(frozen=True)
class ApiAllow:
    vm_info: dict
    kind: Literal["api_allow"] = field(init=False, default="api_allow")


@dataclass(frozen=True)
class BrowserAllow:
    vm_info: dict
    kind: Literal["browser_allow"] = field(init=False, default="browser_allow")


@dataclass(frozen=True)
class FirewallAmbiguous:
    vm_info: dict
    firewall_ambiguous: matching.FirewallAmbiguous
    kind: Literal["firewall_ambiguous"] = field(init=False, default="firewall_ambiguous")


@dataclass(frozen=True)
class FirewallBlock:
    vm_info: dict
    firewall_block: matching.FirewallBlock
    kind: Literal["firewall_block"] = field(init=False, default="firewall_block")


@dataclass(frozen=True)
class FirewallAllow:
    vm_info: dict
    firewall_allow: matching.FirewallAllow
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    kind: Literal["firewall_allow"] = field(init=False, default="firewall_allow")


@dataclass(frozen=True)
class FirewallPolicyAllow:
    vm_info: dict
    firewall_allow: matching.FirewallAllow
    kind: Literal["firewall_policy_allow"] = field(
        init=False,
        default="firewall_policy_allow",
    )


@dataclass(frozen=True)
class PublicDestinationDenied:
    vm_info: dict
    public_destination_denial: PublicDestinationDenial
    kind: Literal["public_destination_denied"] = field(
        init=False,
        default="public_destination_denied",
    )


@dataclass(frozen=True)
class Allow:
    vm_info: dict
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    is_asterisk_form: bool
    kind: Literal["allow"] = field(init=False, default="allow")


RequestClassification: TypeAlias = (
    NoClientIp
    | PassThrough
    | RegistryUnavailable
    | StaleTlsAdmission
    | InvalidRegistryVm
    | AuthorityDenied
    | ApiAllow
    | BrowserAllow
    | FirewallAmbiguous
    | FirewallBlock
    | FirewallAllow
    | FirewallPolicyAllow
    | PublicDestinationDenied
    | Allow
)


def cache_classification(flow: http.HTTPFlow, classification: RequestClassification) -> None:
    """Cache a header-phase classification for request-phase reuse.

    Callers should cache only when the request hook must continue from the same
    classification decision, such as request streaming or header-phase auth
    setup. Terminal and early-response paths must pop the cached value.
    """

    flow.metadata[REQUEST_CLASSIFICATION_METADATA_KEY] = classification


def pop_cached_classification(flow: http.HTTPFlow) -> RequestClassification | None:
    """Remove and return the flow-scoped cached classification, if present."""

    classification = flow.metadata.pop(REQUEST_CLASSIFICATION_METADATA_KEY, None)
    return classification if isinstance(classification, RequestClassification) else None


def cached_classification(flow: http.HTTPFlow) -> RequestClassification | None:
    """Return the flow-scoped cached classification without consuming it."""

    classification = flow.metadata.get(REQUEST_CLASSIFICATION_METADATA_KEY)
    return classification if isinstance(classification, RequestClassification) else None


def classification_for_request(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
) -> RequestClassification:
    """Return the classification the request hook should use.

    The request hook reuses a header-phase cached classification when one was
    intentionally carried forward. Otherwise, it classifies the request using
    the current flow state.
    """

    classification = cached_classification(flow)
    if classification is not None:
        return classification
    return classify_request(
        flow,
        registry_path=registry_path,
        api_url=api_url,
        tls_admission=tls_admission,
    )


def classify_request(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
    defer_unresolved_public_destination: bool = False,
) -> RequestClassification:
    """Classify a flow and write metadata needed by downstream hook handling.

    The decision order is registry/TLS admission, registered VM resolution,
    trusted authority validation, platform API allow, browser passthrough,
    firewall match, publicDestination runtime validation, and default allow.

    After registry and TLS admission checks accept a registered VM,
    classification stores VM/run metadata on the flow. Once trusted authority
    validation succeeds, it stores the original URL, trusted authority host, and
    network log target. Browser passthrough detection also records its metadata
    marker. Header-phase callers that use this as a probe must snapshot and
    restore those metadata fields if they do not carry the classification
    forward.

    `defer_unresolved_public_destination` is for header-phase classification
    before the runtime endpoint may be fully known. A deferred `firewall_allow`
    still requires request-phase publicDestination revalidation before the flow
    is allowed to proceed.
    """

    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None

    if not client_ip:
        if tls_admission is not None:
            return StaleTlsAdmission(
                stale_tls_reason="client_ip_missing",
            )
        return NoClientIp()

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        return RegistryUnavailable(
            registry_unavailable=registry_state,
        )

    if tls_admission is not None and tls_admission.client_ip != client_ip:
        return StaleTlsAdmission(
            stale_tls_reason="client_ip_mismatch",
        )

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is None:
        invalid_vm = registry_state.invalid_vms.get(client_ip)
        if invalid_vm is not None:
            return InvalidRegistryVm(
                invalid_vm=invalid_vm,
            )
        if tls_admission is not None:
            return StaleTlsAdmission(
                stale_tls_reason="registry_entry_missing",
            )
        return PassThrough()

    run_id = vm_info.get("runId", "")
    if (
        tls_admission is not None
        and tls_admission.run_id is not None
        and tls_admission.run_id != run_id
    ):
        return StaleTlsAdmission(
            stale_tls_reason="run_id_mismatch",
        )

    _store_registered_request_metadata(flow, vm_info=vm_info, run_id=run_id)

    if is_browser_passthrough_heuristic(flow):
        flow.metadata[metadata_keys.BROWSER_USER_AGENT] = True

    try:
        trusted_authority = get_trusted_authority(flow)
    except AuthorityValidationError as e:
        return AuthorityDenied(
            vm_info=vm_info,
            authority_error=e,
        )

    original_url = trusted_authority.url
    _store_trusted_authority_metadata(
        flow,
        original_url=original_url,
        host=trusted_authority.host,
        port=trusted_authority.port,
    )

    if upstream_admission.api_destination_matches(
        api_url,
        trusted_authority.host,
        trusted_authority.port,
    ) and not upstream_admission.request_path_uses_platform_firewall(flow.request.path):
        return ApiAllow(vm_info=vm_info)

    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        return BrowserAllow(vm_info=vm_info)

    is_asterisk_form = flow.request.path == "*"
    compiled_firewalls = registry_state.compiled_firewalls.get(client_ip)
    compiled_network_policies = registry_state.compiled_network_policies[client_ip]
    if compiled_firewalls:
        result = matching.match_compiled_firewall_request(
            original_url,
            flow.request.method,
            compiled_firewalls,
            compiled_network_policies,
            connector_intent.from_flow(flow),
            is_asterisk_form=is_asterisk_form,
        )
        if isinstance(result, matching.FirewallAmbiguous):
            return FirewallAmbiguous(
                vm_info=vm_info,
                firewall_ambiguous=result,
            )
        if isinstance(result, matching.FirewallBlock):
            return FirewallBlock(
                vm_info=vm_info,
                firewall_block=result,
            )
        if isinstance(result, matching.FirewallAllow | matching.FirewallPolicyAllow):
            firewall_allow = (
                result.firewall_allow
                if isinstance(result, matching.FirewallPolicyAllow)
                else result
            )
            public_destination_denial = _public_destination_denial(
                flow,
                firewall_allow,
                trusted_authority_host=trusted_authority.host,
                defer_unresolved_hostnames=defer_unresolved_public_destination,
            )
            if public_destination_denial is not None:
                return PublicDestinationDenied(
                    vm_info=vm_info,
                    public_destination_denial=public_destination_denial,
                )
            if isinstance(result, matching.FirewallPolicyAllow):
                return FirewallPolicyAllow(
                    vm_info=vm_info,
                    firewall_allow=firewall_allow,
                )
            return FirewallAllow(
                vm_info=vm_info,
                firewall_allow=firewall_allow,
                builtin_firewall_catalog_snapshot=(
                    registry_state.builtin_firewall_catalog_snapshot
                ),
            )

    return Allow(
        vm_info=vm_info,
        builtin_firewall_catalog_snapshot=registry_state.builtin_firewall_catalog_snapshot,
        is_asterisk_form=is_asterisk_form,
    )


def classification_needs_request_timing(classification: RequestClassification) -> bool:
    return classification.kind in (
        "authority_denied",
        "api_allow",
        "browser_allow",
        "firewall_ambiguous",
        "firewall_block",
        "firewall_allow",
        "firewall_policy_allow",
        "public_destination_denied",
        "allow",
    )


def should_stream_capture_request(classification: RequestClassification) -> bool:
    if not isinstance(classification, ApiAllow | BrowserAllow | FirewallPolicyAllow | Allow):
        return False
    return bool(classification.vm_info.get("captureNetworkBodies", False))


def should_try_firewall_stream_capture_request(classification: RequestClassification) -> bool:
    if not isinstance(classification, FirewallAllow):
        return False
    allow = classification.firewall_allow
    if firewall_allow_uses_public_destination(allow):
        return False
    return bool(classification.vm_info.get("captureNetworkBodies", False))


def firewall_allow_uses_public_destination(allow: matching.FirewallAllow) -> bool:
    host_policy = allow.api_entry.get("hostPolicy")
    return isinstance(host_policy, dict) and host_policy.get("kind") == "publicDestination"


def current_public_destination_denial(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> PublicDestinationDenial | None:
    """Revalidate a firewall allow against the current runtime destination.

    This is required even when `requestheaders()` cached a `firewall_allow`,
    because header-phase publicDestination checks may defer unresolved runtime
    hostnames until the request phase can observe the final destination.
    """

    trusted_authority_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_authority_host:
        try:
            trusted_authority_host = get_trusted_authority(flow).host
        except AuthorityValidationError:
            trusted_authority_host = ""
    return _public_destination_denial(
        flow,
        allow,
        trusted_authority_host=trusted_authority_host,
    )


def is_browser_user_agent(user_agent: str | None) -> bool:
    if not user_agent:
        return False

    normalized = f" {user_agent.lower()}"
    return "mozilla/" in normalized and any(
        marker in normalized for marker in _BROWSER_USER_AGENT_MARKERS
    )


def is_browser_passthrough_heuristic(flow: http.HTTPFlow) -> bool:
    # Short-term business passthrough heuristic for browser-originated traffic.
    # This is not trusted browser provenance: any sandbox client can set this
    # header. The spoofable User-Agent heuristic is currently accepted as a
    # known tradeoff until runner-owned browser provenance is prioritized again.
    return is_browser_user_agent(flow.request.headers.get("User-Agent"))


def restore_request_headers_probe_metadata(
    flow: http.HTTPFlow,
    snapshot: dict[str, object],
    *,
    extra_keys: tuple[str, ...] = (),
) -> None:
    """Restore metadata after a requestheaders classification probe.

    `REQUEST_HEADERS_PROBE_METADATA_KEYS` covers the metadata touched by this
    module and adjacent requestheaders processing that depends on the
    classification result. `extra_keys` lets callers restore companion probe
    metadata owned by other modules, such as connector diagnostics.
    """

    for key in (*REQUEST_HEADERS_PROBE_METADATA_KEYS, *extra_keys):
        if key in snapshot:
            flow.metadata[key] = snapshot[key]
        else:
            flow.metadata.pop(key, None)


def _store_registered_request_metadata(
    flow: http.HTTPFlow,
    *,
    vm_info: dict,
    run_id: str,
) -> None:
    flow.metadata[metadata_keys.VM_RUN_ID] = run_id
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = vm_info.get("networkLogPath", "")
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = vm_info.get("proxyLogPath", "")
    flow.metadata[metadata_keys.CAPTURE_BODY] = vm_info.get("captureNetworkBodies", False)
    flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = vm_info.get("sandboxToken", "")
    flow.metadata[metadata_keys.CLI_AGENT_TYPE] = vm_info.get("cliAgentType") or "claude-code"


def _store_trusted_authority_metadata(
    flow: http.HTTPFlow,
    *,
    original_url: str,
    host: str,
    port: int,
) -> None:
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = host
    http_network_log.set_target(
        flow,
        url=original_url,
        host=host,
        port=port,
    )


def _public_destination_denial(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    trusted_authority_host: str,
    defer_unresolved_hostnames: bool = False,
) -> PublicDestinationDenial | None:
    host_policy = allow.api_entry.get("hostPolicy")
    if not isinstance(host_policy, dict) or host_policy.get("kind") != "publicDestination":
        return None

    validation = _public_destination_runtime_denial(
        flow,
        defer_unresolved_hostnames=defer_unresolved_hostnames,
    )
    if validation is None:
        return None

    raw_base = allow.api_entry.get("base", "")
    base = raw_base if isinstance(raw_base, str) else ""
    if validation.reason is None:
        raise RuntimeError("publicDestination denial is missing a reason")
    return PublicDestinationDenial(
        name=allow.name,
        base=base,
        trusted_authority_host=trusted_authority_host,
        destination_host=validation.destination_host,
        reason=validation.reason,
    )


def _public_destination_runtime_denial(
    flow: http.HTTPFlow,
    *,
    defer_unresolved_hostnames: bool = False,
) -> public_destination.RuntimeDestinationCheck | None:
    for runtime_host in _public_destination_runtime_hosts(flow):
        validation = public_destination.validate_runtime_destination_host(runtime_host)
        if (
            not validation.allowed
            and defer_unresolved_hostnames
            and _public_destination_runtime_host_is_deferable(runtime_host)
        ):
            continue
        if not validation.allowed:
            return validation
    return None


def _public_destination_runtime_hosts(flow: http.HTTPFlow) -> tuple[object, ...]:
    original_address = upstream_destination_binding.server_binding_original_address(
        flow.server_conn
    )

    if flow.server_conn.connected:
        hosts = _public_destination_original_and_request_hosts(flow, original_address)
        hosts.extend(_public_destination_connected_runtime_hosts(flow))
        return tuple(hosts)

    if original_address is not None:
        return tuple(_public_destination_original_and_request_hosts(flow, original_address))

    server_address = connection_endpoints.server_address(flow.server_conn)
    if server_address is not None:
        return (_public_destination_endpoint_host_for_request(flow, server_address),)

    return (flow.request.host,)


def _public_destination_endpoint_host_for_request(
    flow: http.HTTPFlow,
    endpoint: tuple[str, int],
) -> str | None:
    endpoint_host, endpoint_port = endpoint
    if endpoint_port != flow.request.port:
        return None
    return endpoint_host


def _public_destination_original_and_request_hosts(
    flow: http.HTTPFlow,
    original_address: tuple[str, int] | None,
) -> list[object]:
    hosts: list[object] = []
    if original_address is not None:
        endpoint_host = _public_destination_endpoint_host_for_request(flow, original_address)
        if (
            endpoint_host is None
            or public_destination.public_ip_literal_is_public(endpoint_host) is not None
            or not flow.server_conn.connected
        ):
            hosts.append(endpoint_host)
    if public_destination.public_ip_literal_is_public(flow.request.host) is not None:
        hosts.append(flow.request.host)
    return hosts


def _public_destination_connected_runtime_hosts(flow: http.HTTPFlow) -> tuple[object, ...]:
    hosts: list[object] = []
    for endpoint in (
        connection_endpoints.server_peername(flow.server_conn),
        connection_endpoints.server_address(flow.server_conn),
    ):
        if endpoint is None:
            continue

        endpoint_host, endpoint_port = endpoint
        if public_destination.public_ip_literal_is_public(endpoint_host) is None:
            continue

        if endpoint_port != flow.request.port:
            hosts.append(None)
            continue

        hosts.append(endpoint_host)

    if hosts:
        return tuple(hosts)

    connected_endpoint = connection_endpoints.connected_ip_destination_endpoint(
        flow.server_conn,
        port=flow.request.port,
        extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
    )
    return (connected_endpoint[0] if connected_endpoint is not None else None,)


def _public_destination_runtime_host_is_deferable(runtime_host: object) -> bool:
    if not isinstance(runtime_host, str):
        return False
    if public_destination.public_ip_literal_is_public(runtime_host) is not None:
        return False
    try:
        normalize_trusted_hostname(runtime_host)
    except (UnicodeError, ValueError):
        return False
    return True
