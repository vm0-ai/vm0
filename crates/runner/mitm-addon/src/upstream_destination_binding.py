"""Track trusted upstream destinations selected before credential injection."""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from url_utils import normalize_trusted_hostname

BindingKind = Literal["api_allow", "connector_auth"]
_ADDRESS_PAIR_LENGTH = 2


@dataclass(frozen=True)
class UpstreamDestinationBinding:
    host: str
    port: int
    kinds: frozenset[BindingKind]
    original_address: tuple[str, int] | None


_bindings_by_server_id: dict[str, UpstreamDestinationBinding] = {}
_server_ids_by_client_id: dict[str, set[str]] = {}
_client_id_by_server_id: dict[str, str] = {}


def _connection_id(connection: object) -> str | None:
    connection_id = getattr(connection, "id", None)
    if isinstance(connection_id, str) and connection_id:
        return connection_id
    return None


def _address_pair(address: object) -> tuple[str, int] | None:
    if not isinstance(address, tuple) or len(address) < _ADDRESS_PAIR_LENGTH:
        return None
    host, port = address[:_ADDRESS_PAIR_LENGTH]
    if not isinstance(host, str) or not isinstance(port, int):
        return None
    return host, port


def _endpoint_ip_key(host: str) -> str | None:
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


def _endpoint_matches(left: object, right: tuple[str, int]) -> bool:
    left_pair = _address_pair(left)
    if left_pair is None:
        return False
    left_host, left_port = left_pair
    right_host, right_port = right
    if left_port != right_port:
        return False
    left_key = _endpoint_ip_key(left_host)
    right_key = _endpoint_ip_key(right_host)
    return left_key is not None and left_key == right_key


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


def add_server_binding_kind_if_matching(
    server: object,
    *,
    client: object | None = None,
    host: str,
    port: int,
    kind: BindingKind,
) -> bool:
    server_id = _connection_id(server)
    if server_id is None:
        return False
    binding = _bindings_by_server_id.get(server_id)
    if binding is None:
        return False
    normalized_host = normalize_trusted_hostname(host)
    if binding.host != normalized_host or binding.port != port:
        return False
    if kind not in binding.kinds:
        _bindings_by_server_id[server_id] = UpstreamDestinationBinding(
            host=binding.host,
            port=binding.port,
            kinds=binding.kinds | frozenset((kind,)),
            original_address=binding.original_address,
        )
    _associate_server_with_client(server_id, client)
    return True


def forget_server_binding(server: object) -> None:
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
    client_id = _connection_id(client)
    if client_id is None:
        return
    server_ids = _server_ids_by_client_id.pop(client_id, set())
    for server_id in server_ids:
        _bindings_by_server_id.pop(server_id, None)
        _client_id_by_server_id.pop(server_id, None)


def has_server_binding(server: object) -> bool:
    server_id = _connection_id(server)
    return server_id is not None and server_id in _bindings_by_server_id


def _address_matches(host: str, port: int, address: object) -> bool:
    address_pair = _address_pair(address)
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


def _client_binding_matches_connected_endpoint(
    *,
    client: object,
    server: object,
    bindings: tuple[UpstreamDestinationBinding, ...],
) -> bool:
    endpoints = (
        getattr(server, "peername", None),
        getattr(server, "address", None),
        getattr(client, "sockname", None),
    )
    return any(
        any(_endpoint_matches(endpoint, binding.original_address) for endpoint in endpoints)
        for binding in bindings
        if binding.original_address is not None
    )


def diagnostic_snapshot_for_flow(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[BindingKind],
) -> dict[str, object]:
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
    trusted_host = flow.metadata.get(metadata_keys.TRUSTED_AUTHORITY_HOST)
    normalized_host = None
    if isinstance(trusted_host, str):
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
    client_binding_endpoint_match = _client_binding_matches_connected_endpoint(
        client=flow.client_conn,
        server=server,
        bindings=matching_client_bindings,
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
    trusted_host = flow.metadata.get(metadata_keys.TRUSTED_AUTHORITY_HOST)
    if not isinstance(trusted_host, str) or not trusted_host:
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
        )

    matching_client_bindings = _matching_client_bindings(
        flow.client_conn,
        host=normalized_host,
        port=port,
        allowed_kinds=allowed_kinds,
    )
    if bool(getattr(server, "connected", False)):
        return _client_binding_matches_connected_endpoint(
            client=flow.client_conn,
            server=server,
            bindings=matching_client_bindings,
        )

    return _address_matches(normalized_host, port, getattr(server, "address", None))


def binding_snapshot_for_tests() -> dict[str, UpstreamDestinationBinding]:
    return dict(_bindings_by_server_id)


def reset_for_tests() -> None:
    _bindings_by_server_id.clear()
    _server_ids_by_client_id.clear()
    _client_id_by_server_id.clear()
