"""Track trusted upstream destinations selected before credential injection."""

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


def _address_matches(host: str, port: int, address: object) -> bool:
    if not isinstance(address, tuple) or len(address) != _ADDRESS_PAIR_LENGTH:
        return False
    address_host, address_port = address
    if not isinstance(address_host, str) or not isinstance(address_port, int):
        return False
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


def _client_binding_matches(
    client: object,
    *,
    host: str,
    port: int,
    allowed_kinds: frozenset[BindingKind],
) -> bool:
    client_id = _connection_id(client)
    if client_id is None:
        return False

    server_ids = _server_ids_by_client_id.get(client_id)
    if not server_ids:
        return False

    return any(
        _binding_matches(
            binding,
            host=host,
            port=port,
            allowed_kinds=allowed_kinds,
        )
        for server_id in server_ids
        if (binding := _bindings_by_server_id.get(server_id)) is not None
    )


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

    if _client_binding_matches(
        flow.client_conn,
        host=normalized_host,
        port=port,
        allowed_kinds=allowed_kinds,
    ):
        return True

    if bool(getattr(server, "connected", False)):
        return False

    return _address_matches(normalized_host, port, getattr(server, "address", None))


def binding_snapshot_for_tests() -> dict[str, UpstreamDestinationBinding]:
    return dict(_bindings_by_server_id)


def reset_for_tests() -> None:
    _bindings_by_server_id.clear()
    _server_ids_by_client_id.clear()
    _client_id_by_server_id.clear()
