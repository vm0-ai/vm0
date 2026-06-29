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
        ("192.0.0.8", False),
        ("192.0.0.9", True),
        ("192.0.0.10", True),
        ("192.0.0.11", False),
        ("192.0.2.1", False),
        ("2001:4860:4860::8888", True),
        ("2001:db8::1", False),
        ("[2001:4860:4860::8888]", True),
        ("[::1]", False),
        ("2002::1", False),
        ("::ffff:93.184.216.34", False),
        ("93.184.216.34 ", False),
        ("93.184.216.34.", False),
        ("0177.0.0.1", False),
        ("127.0.0.1.", False),
        ("0x7f.0.0.1", False),
        ("127\u30020\u30020\u30021\u3002", False),
        ("2130706433", False),
        ("2130706433.", False),
        ("127.1", False),
        ("127。0。0。1", False),
        ("\uff11\uff12\uff17.\uff10.\uff10.\uff11", False),
        ("127%2e0%2e0%2e1", False),
        ("example%2ecom", False),
        ("example%252ecom", False),
        ("example%2dcom", False),
        ("ex%61mple.com", False),
        ("127%zz0.0.1", False),
        ("example/com", False),
        ("example:443", False),
        ("example@evil.com", False),
        ("example\uff0fcom", False),
        ("example\uff3ccom", False),
        ("[service.example.com]", False),
        (" service.example.com ", False),
        ("", False),
        ("b\u00fccher.example", None),
        ("service\u3002example.com", None),
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
        ("[2001:4860:4860::8888]", True, None),
        ("[::1]", False, "non_public_destination"),
        ("[93.184.216.34]", False, "invalid_destination"),
        ("[service.example.com]", False, "invalid_destination"),
        ("0177.0.0.1", False, "invalid_destination"),
        ("0x7f.0.0.1", False, "invalid_destination"),
        ("2130706433", False, "invalid_destination"),
        ("127.1", False, "invalid_destination"),
        ("127%2e0%2e0%2e1", False, "invalid_destination"),
        ("example%2ecom", False, "invalid_destination"),
        ("127%zz0.0.1", False, "invalid_destination"),
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
