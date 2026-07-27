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
    """Return the first host-port pair from a mitmproxy address tuple.

    ``address`` must be a tuple with at least two elements whose first two values are a
    ``str`` host and an ``int`` port. Additional elements, such as IPv6 flowinfo and scope ID
    fields, are ignored. This validates shape only: it neither parses the host nor validates the
    port value. Unusable shapes return ``None``.
    """
    if not isinstance(address, tuple) or len(address) < _ADDRESS_PAIR_LENGTH:
        return None
    host, port = address[:_ADDRESS_PAIR_LENGTH]
    if not isinstance(host, str) or not isinstance(port, int):
        return None
    return host, port


def authoritative_connected_endpoint(endpoint: object) -> tuple[str, int] | None:
    """Return an endpoint that supplies acceptable connected IP evidence.

    The endpoint must have an ``address_pair`` shape and its host must parse as an IPv4 or IPv6
    literal. DNS names, malformed endpoints, loopback addresses, and unspecified addresses return
    ``None``. Other parsed IP address categories are not filtered: ``authoritative`` describes
    connected endpoint evidence, not public routability. Accepted inputs return their first
    ``(host, port)`` pair. Additional tuple elements are discarded, while the host and port values
    themselves are not normalized.
    """
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
    """Resolve connected IP evidence for ``port`` using fail-closed precedence.

    Check ``server.peername`` and then ``server.address``. The first authoritative primary
    endpoint is final: return it when its port matches, or return ``None`` without consulting
    lower-priority evidence when it does not.

    Only when neither primary endpoint is authoritative are ``extra_endpoints`` checked in order.
    Non-authoritative and wrong-port extras are skipped, and the first authoritative matching-port
    extra is returned. ``None`` means no acceptable evidence established the requested destination,
    including when an authoritative primary endpoint contradicted the requested port.
    """
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
