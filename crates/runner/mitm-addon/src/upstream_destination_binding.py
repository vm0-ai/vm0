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


def _connection_id(connection: object) -> str | None:
    connection_id = getattr(connection, "id", None)
    if isinstance(connection_id, str) and connection_id:
        return connection_id
    return None


def record_server_binding(
    server: object,
    *,
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


def forget_server_binding(server: object) -> None:
    server_id = _connection_id(server)
    if server_id is not None:
        _bindings_by_server_id.pop(server_id, None)


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
        return (
            binding.host == normalized_host
            and binding.port == port
            and bool(binding.kinds & allowed_kinds)
        )

    return _address_matches(normalized_host, port, getattr(server, "address", None))


def binding_snapshot_for_tests() -> dict[str, UpstreamDestinationBinding]:
    return dict(_bindings_by_server_id)


def reset_for_tests() -> None:
    _bindings_by_server_id.clear()
