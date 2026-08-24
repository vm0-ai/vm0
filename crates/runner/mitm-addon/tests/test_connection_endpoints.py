"""Connection endpoint shape contract tests."""

import ipaddress

import pytest

import connection_endpoints


class _Client:
    def __init__(self, peername: object) -> None:
        self.peername = peername


@pytest.mark.parametrize(
    "peername",
    [
        pytest.param((), id="empty-tuple"),
        pytest.param(("10.200.0.5",), id="one-element-tuple"),
        pytest.param((int(ipaddress.IPv4Address("10.200.0.5")), 12345), id="integer-host"),
        pytest.param(("10.200.0.5", "12345"), id="string-port"),
        pytest.param(["10.200.0.5", 12345], id="list"),
    ],
)
def test_client_peername_rejects_malformed_endpoint(peername: object) -> None:
    assert connection_endpoints.client_peername(_Client(peername)) is None


def test_client_peername_rejects_missing_peername() -> None:
    assert connection_endpoints.client_peername(object()) is None


@pytest.mark.parametrize(
    ("peername", "expected"),
    [
        pytest.param(
            ("10.200.0.5", 12345),
            ("10.200.0.5", 12345),
            id="ipv4-pair",
        ),
        pytest.param(
            ("2001:db8::5", 12345, 0, 2),
            ("2001:db8::5", 12345),
            id="ipv6-extra-fields",
        ),
    ],
)
def test_client_peername_returns_host_port_pair(
    peername: tuple[object, ...],
    expected: tuple[str, int],
) -> None:
    assert connection_endpoints.client_peername(_Client(peername)) == expected


@pytest.mark.parametrize(
    "address",
    [
        pytest.param(
            (int(ipaddress.IPv4Address("203.0.113.10")), 443),
            id="integer-host",
        ),
        pytest.param(
            (ipaddress.IPv4Address("203.0.113.10").packed, 443),
            id="packed-bytes-host",
        ),
        pytest.param(("203.0.113.10", "443"), id="string-port"),
    ],
)
def test_address_pair_rejects_malformed_member_types(address: tuple[object, ...]) -> None:
    assert connection_endpoints.address_pair(address) is None


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        pytest.param(
            ("203.0.113.10", 443),
            ("203.0.113.10", 443),
            id="host-port-pair",
        ),
        pytest.param(
            ("2001:db8::1", 443, 0, 2),
            ("2001:db8::1", 443),
            id="ipv6-extra-fields",
        ),
    ],
)
def test_address_pair_returns_host_port_pair(
    address: tuple[object, ...],
    expected: tuple[str, int],
) -> None:
    assert connection_endpoints.address_pair(address) == expected
