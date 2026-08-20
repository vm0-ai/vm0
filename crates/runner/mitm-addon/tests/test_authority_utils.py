"""Shared authority parsing contract tests."""

import pytest

import authority_utils


@pytest.mark.parametrize(
    ("netloc", "expected"),
    [
        pytest.param("", False, id="malformed-empty"),
        pytest.param("[2001:db8::1", False, id="malformed-unclosed-bracket"),
        pytest.param("example.com:443:8443", False, id="malformed-multiple-colons"),
        pytest.param("not-an-ip", True, id="unbracketed-host-without-ip-validation"),
        pytest.param("example.com:443", True, id="unbracketed-host-with-port"),
        pytest.param("[2001:db8::1]", True, id="bracketed-ipv6"),
        pytest.param("[2001:db8::1]:443", True, id="bracketed-ipv6-with-port"),
        pytest.param("[127.0.0.1]", False, id="bracketed-ipv4"),
        pytest.param("[v1.invalid]", False, id="bracketed-non-ip"),
    ],
)
def test_bracketed_authority_host_is_ipv6_contract(netloc, expected):
    assert authority_utils.bracketed_authority_host_is_ipv6(netloc) is expected
