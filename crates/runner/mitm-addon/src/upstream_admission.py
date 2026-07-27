"""TLS and upstream destination admission lifecycle owner."""

import os
import urllib.parse
from dataclasses import dataclass
from typing import Final, Literal

from mitmproxy import connection, ctx, http, tls

import connection_endpoints
import flow_metadata
import matching
import registry
import upstream_destination_binding
from url_utils import normalize_trusted_hostname

TLS_ADMISSION_VALID_REGISTRY_VM: Final = "valid_registry_vm"
TLS_ADMISSION_INVALID_REGISTRY_VM: Final = "invalid_registry_vm"
TLS_ADMISSION_REGISTRY_UNAVAILABLE: Final = "registry_unavailable"

_TEST_ENDPOINT_BYPASS_HEADER: Final = "x-vm0-test-endpoint-bypass"
_PLATFORM_FIREWALL_PATH_PREFIXES: Final = (
    "/api/test/",
    "/api/internal/vm0-model/v1/",
)
_VM0_MODEL_PROXY_PATH_PREFIX: Final = "/api/internal/vm0-model/v1/"
_UPSTREAM_BINDING_DIAGNOSTICS = "_upstream_binding_diagnostics"

TlsAdmissionKind = Literal[
    "valid_registry_vm",
    "invalid_registry_vm",
    "registry_unavailable",
]
_tls_admissions: dict[str, "TlsAdmission"] = {}


@dataclass(frozen=True)
class TlsAdmission:
    client_ip: str
    kind: TlsAdmissionKind
    run_id: str | None = None
    sni: str | None = None


def _client_connection_id(client: object) -> str | None:
    client_id = getattr(client, "id", None)
    if isinstance(client_id, str) and client_id:
        return client_id
    return None


def record_tls_admission(client: object, admission: TlsAdmission) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions[client_id] = admission


def tls_admission_for_client(client: object) -> TlsAdmission | None:
    client_id = _client_connection_id(client)
    if client_id is None:
        return None
    return _tls_admissions.get(client_id)


def forget_tls_admission(client: object) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions.pop(client_id, None)


def reset_tls_admission_state_for_tests() -> None:
    _tls_admissions.clear()


def _connected_verified_tls_destination_endpoint(
    server: object,
    *,
    host: str,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[str, int] | None:
    if bool(getattr(getattr(ctx, "options", object()), "ssl_insecure", False)):
        return None
    if not bool(getattr(server, "tls_established", False)):
        return None
    if getattr(server, "error", None):
        return None
    server_sni = getattr(server, "sni", None)
    if not isinstance(server_sni, str):
        return None
    try:
        normalized_sni = normalize_trusted_hostname(server_sni)
    except (UnicodeError, ValueError):
        return None
    if normalized_sni != host:
        return None
    if not getattr(server, "certificate_list", ()):
        return None

    # mitmproxy verifies the upstream certificate against server.sni when
    # ssl_insecure is false. At this point the connected IP is authenticated as
    # the same host we plan to bind, so CDN/Anycast DNS drift does not matter.
    return connection_endpoints.connected_ip_destination_endpoint(
        server,
        port=port,
        extra_endpoints=extra_endpoints,
    )


def _request_has_platform_test_endpoint_bypass(flow: http.HTTPFlow) -> bool:
    if not flow.request.path.startswith("/api/test/"):
        return False
    expected_bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
    if not expected_bypass:
        return False
    return flow.request.headers.get(_TEST_ENDPOINT_BYPASS_HEADER) == expected_bypass


def request_path_uses_platform_firewall(path: str) -> bool:
    return path.startswith(_PLATFORM_FIREWALL_PATH_PREFIXES)


def _request_allows_platform_connector_auth(flow: http.HTTPFlow) -> bool:
    if flow.request.path.startswith(_VM0_MODEL_PROXY_PATH_PREFIX):
        return True
    # Synthetic test providers live on the platform API preview host but
    # intentionally exercise connector auth injection instead of API auto-allow.
    # Keep this path limited to test endpoints gated by the same internal
    # bypass secret that the API route validates.
    return _request_has_platform_test_endpoint_bypass(flow)


def _requires_platform_connector_auth_bypass(
    *,
    kind: upstream_destination_binding.BindingKind,
    normalized_host: str,
    port: int,
    api_url: str,
) -> bool:
    return kind == "connector_auth" and api_destination_matches(
        api_url,
        normalized_host,
        port,
    )


def _flow_requires_platform_connector_auth_bypass(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
    api_url: str,
) -> bool:
    if kind != "connector_auth":
        return False
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False
    return _requires_platform_connector_auth_bypass(
        kind=kind,
        normalized_host=normalized_host,
        port=flow.request.port,
        api_url=api_url,
    )


def api_destination_matches(api_url: str, hostname: str, port: int) -> bool:
    api_destination = _api_destination(api_url)
    if api_destination is None:
        return False
    api_hostname, api_port = api_destination
    return port == api_port and (hostname == api_hostname or hostname.endswith(f".{api_hostname}"))


def _api_destination(api_url: str) -> tuple[str, int] | None:
    if not api_url:
        return None
    parsed_api = urllib.parse.urlparse(api_url)
    if not parsed_api.hostname:
        return None
    try:
        api_hostname = normalize_trusted_hostname(parsed_api.hostname)
    except (UnicodeError, ValueError):
        return None
    if parsed_api.port is not None:
        api_port = parsed_api.port
    elif parsed_api.scheme.lower() == "http":
        api_port = 80
    else:
        api_port = 443
    return api_hostname, api_port


def _server_connect_binding_kinds(
    *,
    hostname: str,
    port: int,
    compiled_firewalls: matching.CompiledFirewallSet | None,
    is_api_destination: bool,
) -> frozenset[upstream_destination_binding.BindingKind]:
    kinds: set[upstream_destination_binding.BindingKind] = set()
    if is_api_destination:
        kinds.add("api_allow")
    if (
        not is_api_destination
        and compiled_firewalls is not None
        and compiled_firewalls.matches_ordinary_credential_authority(
            hostname,
            port,
        )
    ):
        kinds.add("connector_auth")
    return frozenset(kinds)


def _bind_privileged_upstream_destination(
    *,
    client: object,
    server: connection.Server,
    raw_sni: object,
    registry_state: registry.RegistryState,
    client_ip: str,
    run_id: str,
    api_url: str,
) -> None:
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    tls_admission = tls_admission_for_client(client)
    if tls_admission is not None and (
        tls_admission.client_ip != client_ip
        or tls_admission.kind != TLS_ADMISSION_VALID_REGISTRY_VM
        or (tls_admission.run_id is not None and tls_admission.run_id != run_id)
    ):
        return

    if not isinstance(raw_sni, str) or not raw_sni.strip():
        return
    try:
        hostname = normalize_trusted_hostname(raw_sni.strip())
    except (UnicodeError, ValueError):
        return

    address = connection_endpoints.server_address(server)
    if address is None:
        return
    _original_host, port = address
    is_api_destination = api_destination_matches(api_url, hostname, port)
    reusable_kind: upstream_destination_binding.BindingKind = (
        "api_allow" if is_api_destination else "connector_auth"
    )
    if upstream_destination_binding.reuse_server_binding_kind_if_matching(
        server,
        client=client,
        host=hostname,
        port=port,
        kind=reusable_kind,
    ):
        return

    kinds = _server_connect_binding_kinds(
        hostname=hostname,
        port=port,
        compiled_firewalls=registry_state.compiled_firewalls.get(client_ip),
        is_api_destination=is_api_destination,
    )
    if not kinds:
        return

    if upstream_destination_binding.has_server_binding(server):
        if all(
            upstream_destination_binding.add_server_binding_kind_if_matching(
                server,
                client=client,
                host=hostname,
                port=port,
                kind=kind,
            )
            for kind in kinds
        ):
            return
        return

    if bool(getattr(server, "connected", False)):
        return

    server.address = (hostname, port)

    upstream_destination_binding.record_server_binding(
        server,
        client=client,
        host=hostname,
        port=port,
        kinds=kinds,
        original_address=address,
    )


def handle_server_connect(
    data: object,
    *,
    registry_path: str,
    api_url: str,
) -> None:
    """Bind privileged HTTPS upstream connections to their trusted SNI host."""
    client = getattr(data, "client", None)
    server = getattr(data, "server", None)
    if client is None or server is None:
        return

    client_ip = client.peername[0] if getattr(client, "peername", None) else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is None:
        return

    run_id = vm_info.get("runId", "")
    tls_admission = tls_admission_for_client(client)
    raw_sni = getattr(client, "sni", None)
    if not raw_sni and tls_admission is not None:
        raw_sni = tls_admission.sni
    _bind_privileged_upstream_destination(
        client=client,
        server=server,
        raw_sni=raw_sni,
        registry_state=registry_state,
        client_ip=client_ip,
        run_id=run_id,
        api_url=api_url,
    )


def handle_tls_clienthello(
    data: tls.ClientHelloData,
    *,
    registry_path: str,
    api_url: str,
) -> None:
    """
    Handle TLS ClientHello — decide whether to MITM intercept.
    All registered VMs use MITM mode for HTTP-level filtering and logging.
    Unregistered IPs are passed through without interception.
    """
    client_ip = data.context.client.peername[0] if data.context.client.peername else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_REGISTRY_UNAVAILABLE,
            ),
        )
        return

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is not None:
        run_id = vm_info.get("runId", "")
        raw_sni = data.client_hello.sni
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_VALID_REGISTRY_VM,
                run_id=run_id,
                sni=raw_sni if isinstance(raw_sni, str) else None,
            ),
        )
        _bind_privileged_upstream_destination(
            client=data.context.client,
            server=data.context.server,
            raw_sni=raw_sni,
            registry_state=registry_state,
            client_ip=client_ip,
            run_id=run_id,
            api_url=api_url,
        )
        return

    if client_ip in registry_state.invalid_vms:
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_INVALID_REGISTRY_VM,
            ),
        )
        return

    # Not a registered VM - pass through without MITM interception.
    # This is critical for CIDR-based rules where all VM traffic is redirected.
    forget_tls_admission(data.context.client)
    data.ignore_connection = True


def has_bound_destination(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[upstream_destination_binding.BindingKind],
) -> bool:
    return upstream_destination_binding.flow_matches_bound_destination(
        flow,
        allowed_kinds=allowed_kinds,
    )


def _bind_flow_upstream_destination(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
    api_url: str,
) -> bool:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False

    original_address = connection_endpoints.server_address(flow.server_conn)
    has_server_binding = upstream_destination_binding.has_server_binding(flow.server_conn)
    if _requires_platform_connector_auth_bypass(
        kind=kind,
        normalized_host=normalized_host,
        port=flow.request.port,
        api_url=api_url,
    ) and not _request_allows_platform_connector_auth(flow):
        return False

    if has_server_binding:
        if upstream_destination_binding.add_server_binding_kind_if_matching(
            flow.server_conn,
            client=flow.client_conn,
            host=normalized_host,
            port=flow.request.port,
            kind=kind,
        ):
            return True
        if flow.server_conn.connected:
            connected_address = _connected_verified_tls_destination_endpoint(
                flow.server_conn,
                host=normalized_host,
                port=flow.request.port,
                extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
            )
            if connected_address is None:
                return False
            return (
                upstream_destination_binding.refresh_server_binding_connected_address_if_matching(
                    flow.server_conn,
                    client=flow.client_conn,
                    host=normalized_host,
                    port=flow.request.port,
                    kind=kind,
                    connected_address=connected_address,
                )
            )
        return False

    if flow.server_conn.connected:
        connected_address = _connected_verified_tls_destination_endpoint(
            flow.server_conn,
            host=normalized_host,
            port=flow.request.port,
            extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
        )
        if connected_address is None:
            return False
        original_address = connected_address
    else:
        flow.server_conn.address = (normalized_host, flow.request.port)

    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host=normalized_host,
        port=flow.request.port,
        kinds=frozenset((kind,)),
        original_address=original_address,
    )
    return True


def ensure_bound_destination(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
    api_url: str,
) -> bool:
    """Admit the flow's trusted authority for one privileged binding kind.

    ``flow`` must already carry validated trusted-authority metadata and the
    request, client, and server connection state to bind. ``kind`` selects the
    privileged purpose, while ``api_url`` identifies the platform API authority
    where ``connector_auth`` requires the gated test-endpoint bypass before
    either binding or reusing a destination.

    A direct server binding may be reused, extended with ``kind``, or refreshed
    only while its authority and current destination remain valid. Otherwise an
    unconnected server may be retargeted and bound to the normalized authority;
    a connected server requires current verified upstream TLS and authoritative
    endpoint evidence rather than fresh DNS. Client-associated matches are not
    durable proof for the current server connection, so they still pass through
    the direct binding path.

    Return ``True`` only when the current server connection is directly admitted
    for the flow authority, port, and requested kind. ``False`` does not create a
    response and must not be treated as admission: request-header callers may use
    the attempt for best-effort prebinding or defer the decision, but terminal
    callers must fail closed before API auto-allow or ordinary connector
    credential injection.
    """
    if _flow_requires_platform_connector_auth_bypass(
        flow,
        kind=kind,
        api_url=api_url,
    ) and not _request_allows_platform_connector_auth(flow):
        return False

    allowed_kinds = frozenset((kind,))
    has_bound = has_bound_destination(flow, allowed_kinds=allowed_kinds)
    if has_bound and upstream_destination_binding.has_server_binding(flow.server_conn):
        return True
    # If has_bound is true here, it is only an unconnected address or
    # prior-client match. That is retargetable, not durable proof for later
    # keepalive reuse, and connected flows still need current upstream TLS proof.
    return _bind_flow_upstream_destination(flow, kind=kind, api_url=api_url)


def forget_server_binding(server: object) -> None:
    upstream_destination_binding.forget_server_binding(server)


def forget_server_binding_from_event(data: object) -> None:
    server = getattr(data, "server", data)
    forget_server_binding(server)


def forget_client(client: object) -> None:
    forget_tls_admission(client)
    upstream_destination_binding.forget_client_bindings(client)


def _endpoint_text(address: tuple[str, int] | None) -> str:
    if address is None:
        return ""
    host, port = address
    return f"{host}:{port}"


def record_unbound_diagnostics(
    flow: http.HTTPFlow,
    *,
    reason: upstream_destination_binding.BindingKind,
) -> dict[str, object]:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    diagnostics = upstream_destination_binding.diagnostic_snapshot_for_flow(
        flow,
        allowed_kinds=frozenset((reason,)),
    )
    diagnostics.update(
        {
            "reason": reason,
            "trusted_host": trusted_host,
            "request_host": flow.request.host,
            "request_port": flow.request.port,
            "server_connected": bool(getattr(flow.server_conn, "connected", False)),
            "server_address": _endpoint_text(connection_endpoints.server_address(flow.server_conn)),
            "server_peername": _endpoint_text(
                connection_endpoints.server_peername(flow.server_conn)
            ),
            "server_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.server_conn)
            ),
            "client_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.client_conn)
            ),
        }
    )
    flow.metadata[_UPSTREAM_BINDING_DIAGNOSTICS] = diagnostics
    return diagnostics


def upstream_binding_log_fields(flow: http.HTTPFlow) -> dict[str, str | int | bool]:
    # [NETWORK_LOG_FIELDS] — shared schema and UI boundary is api-contracts.
    diagnostics = flow.metadata.get(_UPSTREAM_BINDING_DIAGNOSTICS)
    if not isinstance(diagnostics, dict):
        return {}
    return {
        f"upstream_binding_{key}": value
        for key, value in diagnostics.items()
        if isinstance(value, (str, int, bool))
    }


def upstream_binding_diagnostics_for_tests(flow: http.HTTPFlow) -> dict[str, object]:
    diagnostics = flow.metadata.get(_UPSTREAM_BINDING_DIAGNOSTICS)
    if not isinstance(diagnostics, dict):
        return {}
    return diagnostics
