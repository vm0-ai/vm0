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


def authoritative_connected_endpoint(endpoint: object) -> tuple[str, int] | None:
    endpoint_pair = address_pair(endpoint)
    if endpoint_pair is None:
        return None
    endpoint_host, _endpoint_port = endpoint_pair
    try:
        endpoint_ip = ipaddress.ip_address(endpoint_host)
    except ValueError:
        return None
    if endpoint_ip.is_loopback or endpoint_ip.is_unspecified:
        return None
    return endpoint_pair


def connected_ip_destination_endpoint(
    server: object,
    *,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[str, int] | None:
    peername = authoritative_connected_endpoint(server_peername(server))
    if peername is not None:
        return peername if peername[1] == port else None

    address = authoritative_connected_endpoint(server_address(server))
    if address is not None:
        return address if address[1] == port else None

    for extra_endpoint in extra_endpoints:
        endpoint = authoritative_connected_endpoint(extra_endpoint)
        if endpoint is not None and endpoint[1] == port:
            return endpoint

    return None
