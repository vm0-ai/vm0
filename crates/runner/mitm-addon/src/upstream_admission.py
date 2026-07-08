"""TLS and upstream destination admission lifecycle owner."""

import asyncio
import functools
import ipaddress
import os
import socket
import time
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
_UPSTREAM_BINDING_DIAGNOSTICS = "_upstream_binding_diagnostics"
_TRUSTED_HOST_ADDRESS_CACHE_TTL_SECONDS: Final = 60.0
_TRUSTED_HOST_ADDRESS_NEGATIVE_CACHE_TTL_SECONDS: Final = 5.0
_TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES: Final = 512

TlsAdmissionKind = Literal[
    "valid_registry_vm",
    "invalid_registry_vm",
    "registry_unavailable",
]
_ApiOriginalAddressSource = Literal["server_address", "client_sockname"]

_trusted_host_address_cache: dict[tuple[str, int], tuple[float, frozenset[str]]] = {}
_trusted_host_address_lookup_tasks: dict[tuple[str, int], asyncio.Task[frozenset[str]]] = {}
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


def _ip_address_text(host: str) -> str | None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    return str(address)


def trusted_host_address_cache_time() -> float:
    return time.monotonic()


def _cached_trusted_host_addresses(
    cache_key: tuple[str, int],
    *,
    now: float,
) -> frozenset[str] | None:
    cached = _trusted_host_address_cache.get(cache_key)
    if cached is not None:
        expires_at, cached_addresses = cached
        if expires_at > now:
            return cached_addresses
        _trusted_host_address_cache.pop(cache_key, None)
    return None


def _cache_trusted_host_addresses(
    cache_key: tuple[str, int],
    addresses: frozenset[str],
    *,
    now: float,
) -> None:
    if len(_trusted_host_address_cache) >= _TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES:
        expired_keys = [
            key
            for key, (expires_at, _addresses) in _trusted_host_address_cache.items()
            if expires_at <= now
        ]
        for key in expired_keys:
            _trusted_host_address_cache.pop(key, None)
        if len(_trusted_host_address_cache) >= _TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES:
            _trusted_host_address_cache.pop(next(iter(_trusted_host_address_cache)), None)

    ttl = (
        _TRUSTED_HOST_ADDRESS_CACHE_TTL_SECONDS
        if addresses
        else _TRUSTED_HOST_ADDRESS_NEGATIVE_CACHE_TTL_SECONDS
    )
    _trusted_host_address_cache[cache_key] = (now + ttl, addresses)


def _resolve_trusted_host_addresses_sync(host: str, port: int) -> frozenset[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return frozenset()

    address_set: set[str] = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        sockaddr_host = sockaddr[0]
        if not isinstance(sockaddr_host, str):
            continue
        resolved_ip = _ip_address_text(sockaddr_host)
        if resolved_ip is not None:
            address_set.add(resolved_ip)

    return frozenset(address_set)


def _complete_trusted_host_address_lookup(
    cache_key: tuple[str, int],
    task: asyncio.Task[frozenset[str]],
) -> None:
    if _trusted_host_address_lookup_tasks.get(cache_key) is not task:
        return
    _trusted_host_address_lookup_tasks.pop(cache_key, None)
    if task.cancelled():
        return
    resolved_addresses = task.result()
    _cache_trusted_host_addresses(
        cache_key,
        resolved_addresses,
        now=trusted_host_address_cache_time(),
    )


async def resolved_trusted_host_addresses(host: str, port: int) -> frozenset[str]:
    cache_key = (host, port)
    cached = _cached_trusted_host_addresses(cache_key, now=trusted_host_address_cache_time())
    if cached is not None:
        return cached

    lookup_task = _trusted_host_address_lookup_tasks.get(cache_key)
    if lookup_task is None:
        lookup_task = asyncio.create_task(
            asyncio.to_thread(_resolve_trusted_host_addresses_sync, host, port)
        )
        _trusted_host_address_lookup_tasks[cache_key] = lookup_task
        lookup_task.add_done_callback(
            functools.partial(_complete_trusted_host_address_lookup, cache_key)
        )

    return await asyncio.shield(lookup_task)


def reset_upstream_destination_resolution_cache_for_tests() -> None:
    _trusted_host_address_cache.clear()
    _trusted_host_address_lookup_tasks.clear()


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


def _request_allows_platform_connector_auth(flow: http.HTTPFlow) -> bool:
    # Synthetic test providers live on the platform API preview host but
    # intentionally exercise connector auth injection instead of API auto-allow.
    # Keep this path limited to test endpoints gated by the same internal
    # bypass secret that the API route validates.
    return _request_has_platform_test_endpoint_bypass(flow)


def _requires_platform_connector_auth_bypass(
    *,
    kind: upstream_destination_binding.BindingKind,
    normalized_host: str,
    api_url: str,
) -> bool:
    return kind == "connector_auth" and api_hostname_matches(api_url, normalized_host)


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
        api_url=api_url,
    )


def api_hostname_matches(api_url: str, hostname: str) -> bool:
    api_destination = _api_destination(api_url)
    if api_destination is None:
        return False
    api_hostname, _api_port = api_destination
    return hostname == api_hostname or hostname.endswith(f".{api_hostname}")


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


async def _address_resolves_to_trusted_host(
    address: tuple[str, int] | None,
    *,
    host: str,
    port: int,
) -> bool:
    if address is None:
        return False
    address_host, address_port = address
    if address_port != port:
        return False
    address_ip = _ip_address_text(address_host)
    if address_ip is None:
        return False
    return address_ip in await resolved_trusted_host_addresses(host, port)


async def _bind_api_upstream_destination_from_original_address(
    *,
    client: object,
    server: connection.Server,
    api_url: str,
) -> bool:
    if bool(getattr(server, "connected", False)) or getattr(server, "error", None):
        return False

    api_destination = _api_destination(api_url)
    if api_destination is None:
        return False
    api_hostname, api_port = api_destination

    starting_server_address = connection_endpoints.server_address(server)
    starting_client_sockname = connection_endpoints.connection_sockname(client)
    original_address: tuple[str, int] | None = None
    original_address_source: _ApiOriginalAddressSource | None = None
    candidate_addresses: tuple[
        tuple[_ApiOriginalAddressSource, tuple[str, int] | None],
        ...,
    ] = (
        ("server_address", starting_server_address),
        ("client_sockname", starting_client_sockname),
    )
    for candidate_source, candidate_address in candidate_addresses:
        if await _address_resolves_to_trusted_host(
            candidate_address,
            host=api_hostname,
            port=api_port,
        ):
            original_address = candidate_address
            original_address_source = candidate_source
            break
    if original_address is None or original_address_source is None:
        return False
    if bool(getattr(server, "connected", False)) or getattr(server, "error", None):
        return False
    if connection_endpoints.server_address(server) != starting_server_address:
        return False
    if not _original_address_source_still_matches(
        client=client,
        server=server,
        original_address=original_address,
        source=original_address_source,
    ):
        return False

    server.address = (api_hostname, api_port)
    upstream_destination_binding.record_server_binding(
        server,
        client=client,
        host=api_hostname,
        port=api_port,
        kinds=frozenset(("api_allow",)),
        original_address=original_address,
    )
    return True


def _original_address_source_still_matches(
    *,
    client: object,
    server: object,
    original_address: tuple[str, int],
    source: _ApiOriginalAddressSource,
) -> bool:
    if source == "server_address":
        return connection_endpoints.server_address(server) == original_address
    return connection_endpoints.connection_sockname(client) == original_address


def _server_connect_binding_kinds(
    *,
    hostname: str,
    port: int,
    compiled_firewalls: matching.CompiledFirewallSet | None,
    api_url: str,
) -> frozenset[upstream_destination_binding.BindingKind]:
    kinds: set[upstream_destination_binding.BindingKind] = set()
    is_api_host = api_hostname_matches(api_url, hostname)
    if is_api_host:
        kinds.add("api_allow")
    if (
        not is_api_host
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

    kinds = _server_connect_binding_kinds(
        hostname=hostname,
        port=port,
        compiled_firewalls=registry_state.compiled_firewalls.get(client_ip),
        api_url=api_url,
    )
    if not kinds:
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


async def handle_server_connect(
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
    if not raw_sni and await _bind_api_upstream_destination_from_original_address(
        client=client,
        server=server,
        api_url=api_url,
    ):
        return
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
