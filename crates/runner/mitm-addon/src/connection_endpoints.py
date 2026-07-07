"""Read-only helpers for mitmproxy connection endpoint shapes."""

import ipaddress

_ADDRESS_PAIR_LENGTH = 2


def server_address(server: object) -> tuple[str, int] | None:
    return address_pair(getattr(server, "address", None))


def server_peername(server: object) -> tuple[str, int] | None:
    return address_pair(getattr(server, "peername", None))


def connection_sockname(connection: object) -> tuple[str, int] | None:
    return address_pair(getattr(connection, "sockname", None))


def address_pair(address: object) -> tuple[str, int] | None:
    if not isinstance(address, tuple) or len(address) < _ADDRESS_PAIR_LENGTH:
        return None
    host, port = address[:_ADDRESS_PAIR_LENGTH]
    if not isinstance(host, str) or not isinstance(port, int):
        return None
    return host, port


def is_authoritative_connected_endpoint(endpoint: tuple[str, int] | None) -> bool:
    if endpoint is None:
        return False
    endpoint_host, _endpoint_port = endpoint
    try:
        endpoint_ip = ipaddress.ip_address(endpoint_host)
    except ValueError:
        return False
    return not endpoint_ip.is_loopback and not endpoint_ip.is_unspecified


def connected_ip_destination_endpoint(
    server: object,
    *,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[str, int] | None:
    for peer in connected_destination_candidate_endpoints(
        server,
        extra_endpoints=extra_endpoints,
    ):
        if peer is None:
            continue

        _peer_host, peer_port = peer
        if peer_port != port:
            continue

        if is_authoritative_connected_endpoint(peer):
            return peer

    return None


def connected_destination_candidate_endpoints(
    server: object,
    *,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[tuple[str, int] | None, ...]:
    peername = server_peername(server)
    if is_authoritative_connected_endpoint(peername):
        return (peername,)

    address = server_address(server)
    if is_authoritative_connected_endpoint(address):
        return (address,)

    return (peername, address, *extra_endpoints)
