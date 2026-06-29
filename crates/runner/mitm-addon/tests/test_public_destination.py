"""Public destination host-policy address classification tests."""

import pytest

import public_destination


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("93.184.216.34", True),
        ("10.0.0.1", False),
        ("127.0.0.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("192.0.2.1", False),
        ("2001:4860:4860::8888", True),
        ("2001:db8::1", False),
        ("2002::1", False),
        ("::ffff:93.184.216.34", False),
        ("service.example.com", None),
    ],
)
def test_public_ip_literal_is_public(host, expected):
    assert public_destination.public_ip_literal_is_public(host) is expected


@pytest.mark.parametrize(
    ("host", "allowed", "reason"),
    [
        ("93.184.216.34", True, None),
        ("93.184.216.34 ", False, "invalid_destination"),
        (" 93.184.216.34", False, "invalid_destination"),
        ("10.0.0.1", False, "non_public_destination"),
        ("127.0.0.1", False, "non_public_destination"),
        ("169.254.169.254", False, "non_public_destination"),
        ("64:ff9b::5db8:d822", False, "non_public_destination"),
        ("2001:4860:4860::8888%eth0", False, "non_public_destination"),
        ("::ffff:10.0.0.1", False, "non_public_destination"),
        ("::ffff:93.184.216.34", False, "non_public_destination"),
        ("[2001:4860:4860::8888]", False, "invalid_destination"),
        ("service.example.com", False, "invalid_destination"),
        ("", False, "missing_destination"),
        (" ", False, "missing_destination"),
        (None, False, "missing_destination"),
    ],
)
def test_validate_runtime_destination_host(host, allowed, reason):
    result = public_destination.validate_runtime_destination_host(host)

    assert result.allowed is allowed
    assert result.reason == reason
