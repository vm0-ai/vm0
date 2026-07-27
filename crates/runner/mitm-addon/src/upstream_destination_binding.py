"""Bind trusted authorities to concrete upstream destinations.

This module records the upstream endpoint selected before VM0 API allow traffic
or connector credential injection can proceed. Bindings are keyed by mitmproxy
server connection id and associated with client connection id so connection
reuse can fall back to earlier bindings from the same client.

Direct server bindings take precedence over client-associated fallback
bindings. Connected flows must be proven by authoritative endpoint evidence
from the live connection; fresh DNS is not proof that a connected upstream is
still the trusted destination. Callers must discard bindings when mitmproxy
reports disconnects, connect errors, local responses, request errors, or
header-phase termination.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http

import connection_endpoints
import flow_metadata
from url_utils import normalize_trusted_hostname

# Public API used by mitm_addon hooks and tests. Private helpers encode the
# endpoint matching details and are intentionally not exported.
__all__ = (
    "BindingKind",
    "UpstreamDestinationBinding",
    "add_server_binding_kind_if_matching",
    "binding_snapshot_for_tests",
    "bound_destination_endpoint_for_flow",
    "diagnostic_snapshot_for_flow",
    "flow_matches_bound_destination",
    "flow_matches_direct_bound_destination",
    "forget_client_bindings",
    "forget_server_binding",
    "has_server_binding",
    "record_server_binding",
    "refresh_server_binding_connected_address_if_matching",
    "reset_for_tests",
    "reuse_server_binding_kind_if_matching",
    "server_binding_original_address",
)

# `api_allow` authorizes VM0 API traffic. `connector_auth` authorizes ordinary
# upstream credential injection for connector firewalls.
BindingKind = Literal["api_allow", "connector_auth"]


@dataclass(frozen=True)
class UpstreamDestinationBinding:
    """Trusted destination state recorded for one mitmproxy server connection."""

    # Normalized trusted authority host and request port that future flows must
    # match before this binding can be reused.
    host: str
    port: int
    # Binding purposes that have already passed their caller-specific safety
    # gate for this connection.
    kinds: frozenset[BindingKind]
    # Concrete endpoint observed before retargeting, or a verified endpoint for
    # an already-connected flow. This is not a DNS cache entry.
    original_address: tuple[str, int] | None


_bindings_by_server_id: dict[str, UpstreamDestinationBinding] = {}
_server_ids_by_client_id: dict[str, set[str]] = {}
_client_id_by_server_id: dict[str, str] = {}


def _connection_id(connection: object) -> str | None:
    connection_id = getattr(connection, "id", None)
    if isinstance(connection_id, str) and connection_id:
        return connection_id
    return None


def _endpoint_ip_key(host: str) -> str | None:
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


def _endpoint_matches(left: object, right: tuple[str, int]) -> bool:
    left_pair = connection_endpoints.address_pair(left)
    if left_pair is None:
        return False
    left_host, left_port = left_pair
    right_host, right_port = right
    if left_port != right_port:
        return False
    left_key = _endpoint_ip_key(left_host)
    right_key = _endpoint_ip_key(right_host)
    return left_key is not None and left_key == right_key


def _endpoint_matches_any(
    endpoint: object,
    bindings: tuple[UpstreamDestinationBinding, ...],
) -> bool:
    return any(
        _endpoint_matches(endpoint, binding.original_address)
        for binding in bindings
        if binding.original_address is not None
    )


def _associate_server_with_client(server_id: str, client: object | None) -> None:
    client_id = _connection_id(client)
    if client_id is None:
        return
    existing_client_id = _client_id_by_server_id.get(server_id)
    if existing_client_id is not None and existing_client_id != client_id:
        server_ids = _server_ids_by_client_id.get(existing_client_id)
        if server_ids is not None:
            server_ids.discard(server_id)
            if not server_ids:
                _server_ids_by_client_id.pop(existing_client_id, None)
    _client_id_by_server_id[server_id] = client_id
    _server_ids_by_client_id.setdefault(client_id, set()).add(server_id)


def record_server_binding(
    server: object,
    *,
    client: object | None = None,
    host: str,
    port: int,
    kinds: frozenset[BindingKind],
    original_address: tuple[str, int] | None,
) -> None:
    """Record a destination after the caller retargeted or verified upstream."""
    server_id = _connection_id(server)
    if server_id is None:
        return
    _bindings_by_server_id[server_id] = UpstreamDestinationBinding(
        host=normalize_trusted_hostname(host),
        port=port,
        kinds=kinds,
        original_address=original_address,
    )
    _associate_server_with_client(server_id, client)


def _matching_server_binding(
    server: object,
    *,
    host: str,
    port: int,
) -> tuple[str, UpstreamDestinationBinding] | None:
    server_id = _connection_id(server)
    if server_id is None:
        return None
    binding = _bindings_by_server_id.get(server_id)
    if binding is None:
        return None
    normalized_host = normalize_trusted_hostname(host)
    if binding.host != normalized_host or binding.port != port:
        return None
    if not _server_binding_matches_current_destination(server, binding):
        return None
    return server_id, binding


def reuse_server_binding_kind_if_matching(
    server: object,
    *,
    client: object | None = None,
    host: str,
    port: int,
    kind: BindingKind,
) -> bool:
    """Reuse an existing binding kind without authorizing a missing kind."""
    matched = _matching_server_binding(server, host=host, port=port)
    if matched is None:
        return False
    server_id, binding = matched
    if kind not in binding.kinds:
        return False
    _associate_server_with_client(server_id, client)
    return True


def add_server_binding_kind_if_matching(
    server: object,
    *,
    client: object | None = None,
    host: str,
    port: int,
    kind: BindingKind,
) -> bool:
    """Add a binding kind only if the current server destination still matches."""
    matched = _matching_server_binding(server, host=host, port=port)
    if matched is None:
        return False
    server_id, binding = matched
    if kind not in binding.kinds:
        _bindings_by_server_id[server_id] = UpstreamDestinationBinding(
            host=binding.host,
            port=binding.port,
            kinds=binding.kinds | frozenset((kind,)),
            original_address=binding.original_address,
        )
    _associate_server_with_client(server_id, client)
    return True


def refresh_server_binding_connected_address_if_matching(
    server: object,
    *,
    client: object | None = None,
    host: str,
    port: int,
    kind: BindingKind,
    connected_address: tuple[str, int],
) -> bool:
    """Replace original_address with a verified connected endpoint if safe."""
    server_id = _connection_id(server)
    if server_id is None:
        return False
    binding = _bindings_by_server_id.get(server_id)
    if binding is None:
        return False
    normalized_host = normalize_trusted_hostname(host)
    if binding.host != normalized_host or binding.port != port:
        return False
    connected_pair = connection_endpoints.authoritative_connected_endpoint(connected_address)
    if connected_pair is None:
        return False

    refreshed_binding = UpstreamDestinationBinding(
        host=binding.host,
        port=binding.port,
        kinds=binding.kinds | frozenset((kind,)),
        original_address=connected_pair,
    )
    _bindings_by_server_id[server_id] = refreshed_binding
    _associate_server_with_client(server_id, client)
    return True


def forget_server_binding(server: object) -> None:
    """Discard all binding state owned by one mitmproxy server connection."""
    server_id = _connection_id(server)
    if server_id is not None:
        _bindings_by_server_id.pop(server_id, None)
        client_id = _client_id_by_server_id.pop(server_id, None)
        if client_id is not None:
            server_ids = _server_ids_by_client_id.get(client_id)
            if server_ids is not None:
                server_ids.discard(server_id)
                if not server_ids:
                    _server_ids_by_client_id.pop(client_id, None)


def forget_client_bindings(client: object) -> None:
    """Discard bindings associated with a disconnected client connection."""
    client_id = _connection_id(client)
    if client_id is None:
        return
    server_ids = _server_ids_by_client_id.pop(client_id, set())
    for server_id in server_ids:
        _bindings_by_server_id.pop(server_id, None)
        _client_id_by_server_id.pop(server_id, None)


def has_server_binding(server: object) -> bool:
    """Return whether the server connection has a direct binding."""
    server_id = _connection_id(server)
    return server_id is not None and server_id in _bindings_by_server_id


def server_binding_original_address(server: object) -> tuple[str, int] | None:
    """Return the original endpoint only while the server address still matches."""
    server_id = _connection_id(server)
    if server_id is None:
        return None
    binding = _bindings_by_server_id.get(server_id)
    if binding is None or binding.original_address is None:
        return None
    if not _address_matches(binding.host, binding.port, getattr(server, "address", None)):
        return None
    return binding.original_address


def _address_matches(host: str, port: int, address: object) -> bool:
    address_pair = connection_endpoints.address_pair(address)
    if address_pair is None:
        return False
    address_host, address_port = address_pair
    try:
        normalized_address_host = normalize_trusted_hostname(address_host)
    except (UnicodeError, ValueError):
        return False
    return normalized_address_host == host and address_port == port


def _binding_matches(
    binding: UpstreamDestinationBinding,
    *,
    host: str,
    port: int,
    allowed_kinds: frozenset[BindingKind],
) -> bool:
    return binding.host == host and binding.port == port and bool(binding.kinds & allowed_kinds)


def _server_binding_matches_current_destination(
    server: object,
    binding: UpstreamDestinationBinding,
    *,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> bool:
    if bool(getattr(server, "connected", False)):
        connected_endpoint = connection_endpoints.connected_ip_destination_endpoint(
            server,
            port=binding.port,
            extra_endpoints=extra_endpoints,
        )
        return (
            binding.original_address is not None
            and connected_endpoint is not None
            and _endpoint_matches(connected_endpoint, binding.original_address)
        )
    return _address_matches(binding.host, binding.port, getattr(server, "address", None))


def _matching_client_bindings(
    client: object,
    *,
    host: str,
    port: int,
    allowed_kinds: frozenset[BindingKind],
) -> tuple[UpstreamDestinationBinding, ...]:
    client_id = _connection_id(client)
    if client_id is None:
        return ()

    server_ids = _server_ids_by_client_id.get(client_id)
    if not server_ids:
        return ()

    return tuple(
        binding
        for server_id in server_ids
        if (binding := _bindings_by_server_id.get(server_id)) is not None
        and _binding_matches(binding, host=host, port=port, allowed_kinds=allowed_kinds)
    )


def _client_binding_connected_endpoint(
    *,
    client: object,
    server: object,
    port: int,
    bindings: tuple[UpstreamDestinationBinding, ...],
) -> tuple[str, int] | None:
    connected_endpoint = connection_endpoints.connected_ip_destination_endpoint(
        server,
        port=port,
        extra_endpoints=(connection_endpoints.connection_sockname(client),),
    )
    if connected_endpoint is None or not _endpoint_matches_any(connected_endpoint, bindings):
        return None
    return connected_endpoint


def diagnostic_snapshot_for_flow(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[BindingKind],
) -> dict[str, object]:
    """Return binding state for blocked-request logs, not authorization.

    The snapshot reports whether the current server connection has a direct
    binding, how many bindings are associated with the client, whether any
    client binding matches host/port/kind, and whether a connected endpoint
    matches those client bindings. The host list is diagnostic context only.
    """
    server = flow.server_conn
    server_id = _connection_id(server)
    direct_binding = _bindings_by_server_id.get(server_id) if server_id is not None else None

    client_id = _connection_id(flow.client_conn)
    client_server_ids = _server_ids_by_client_id.get(client_id, set()) if client_id else set()
    client_bindings = [
        binding
        for bound_server_id in client_server_ids
        if (binding := _bindings_by_server_id.get(bound_server_id)) is not None
    ]
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    normalized_host = None
    if trusted_host:
        try:
            normalized_host = normalize_trusted_hostname(trusted_host)
        except (UnicodeError, ValueError):
            normalized_host = None
    matching_client_bindings = (
        tuple(
            binding
            for binding in client_bindings
            if _binding_matches(
                binding,
                host=normalized_host,
                port=flow.request.port,
                allowed_kinds=allowed_kinds,
            )
        )
        if normalized_host is not None
        else ()
    )
    client_binding_endpoint_match = (
        _client_binding_connected_endpoint(
            client=flow.client_conn,
            server=server,
            port=flow.request.port,
            bindings=matching_client_bindings,
        )
        is not None
    )
    return {
        "server_id": server_id or "",
        "client_id": client_id or "",
        "direct_binding_present": direct_binding is not None,
        "direct_binding_host": direct_binding.host if direct_binding is not None else "",
        "direct_binding_port": direct_binding.port if direct_binding is not None else 0,
        "direct_binding_kinds": ",".join(sorted(direct_binding.kinds))
        if direct_binding is not None
        else "",
        "client_binding_count": len(client_bindings),
        "client_binding_match": bool(matching_client_bindings),
        "client_binding_endpoint_match": client_binding_endpoint_match,
        "client_binding_hosts": ",".join(
            sorted({f"{binding.host}:{binding.port}" for binding in client_bindings})[:8]
        ),
    }


def flow_matches_bound_destination(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[BindingKind],
) -> bool:
    """Return whether a flow is bound to its authority for an allowed kind.

    A direct server binding is checked first. Without one, a prior binding from
    the same client may be used as fallback, but connected flows still require
    authoritative endpoint evidence matching the bound concrete endpoint.
    """
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False

    port = flow.request.port
    server = flow.server_conn
    server_id = _connection_id(server)
    binding = _bindings_by_server_id.get(server_id) if server_id is not None else None
    if binding is not None:
        return _binding_matches(
            binding,
            host=normalized_host,
            port=port,
            allowed_kinds=allowed_kinds,
        ) and _server_binding_matches_current_destination(server, binding)

    matching_client_bindings = _matching_client_bindings(
        flow.client_conn,
        host=normalized_host,
        port=port,
        allowed_kinds=allowed_kinds,
    )
    if bool(getattr(server, "connected", False)):
        return (
            _client_binding_connected_endpoint(
                client=flow.client_conn,
                server=server,
                port=port,
                bindings=matching_client_bindings,
            )
            is not None
        )

    return _address_matches(normalized_host, port, getattr(server, "address", None))


def flow_matches_direct_bound_destination(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[BindingKind],
) -> bool:
    """Return whether the current server has a matching direct binding.

    Connected transparent flows include the client socket endpoint as the same
    authoritative evidence accepted when the direct binding was created.
    """
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False

    server = flow.server_conn
    server_id = _connection_id(server)
    binding = _bindings_by_server_id.get(server_id) if server_id is not None else None
    if binding is None:
        return False
    return _binding_matches(
        binding,
        host=normalized_host,
        port=flow.request.port,
        allowed_kinds=allowed_kinds,
    ) and _server_binding_matches_current_destination(
        server,
        binding,
        extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
    )


def bound_destination_endpoint_for_flow(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[BindingKind],
) -> tuple[str, int] | None:
    """Return the concrete endpoint proven by a matching binding, if any.

    Host-policy checks use this endpoint as connection evidence. A connected
    fallback match returns the live authoritative endpoint, not a DNS result.
    """
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return None
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return None

    port = flow.request.port
    server = flow.server_conn
    server_id = _connection_id(server)
    binding = _bindings_by_server_id.get(server_id) if server_id is not None else None
    if (
        binding is not None
        and _binding_matches(
            binding,
            host=normalized_host,
            port=port,
            allowed_kinds=allowed_kinds,
        )
        and _server_binding_matches_current_destination(server, binding)
    ):
        return binding.original_address

    matching_client_bindings = _matching_client_bindings(
        flow.client_conn,
        host=normalized_host,
        port=port,
        allowed_kinds=allowed_kinds,
    )
    if bool(getattr(server, "connected", False)):
        return _client_binding_connected_endpoint(
            client=flow.client_conn,
            server=server,
            port=port,
            bindings=matching_client_bindings,
        )
    return None


def binding_snapshot_for_tests() -> dict[str, UpstreamDestinationBinding]:
    """Return a shallow copy of server bindings for hook-level tests."""
    return dict(_bindings_by_server_id)


def reset_for_tests() -> None:
    """Clear module state between mitm-addon tests."""
    _bindings_by_server_id.clear()
    _server_ids_by_client_id.clear()
    _client_id_by_server_id.clear()
