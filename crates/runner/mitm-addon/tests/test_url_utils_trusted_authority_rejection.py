"""Trusted request authority rejection URL utility tests."""

import pytest

from tests.host_normalization_cases import (
    INVALID_IDNA_HOSTNAME_CASES,
    ONLY_DOTS_HOSTNAME,
)
from url_utils import AuthorityValidationError, get_trusted_authority

_INVALID_TRUSTED_HOSTNAME_CASES = (
    pytest.param("{api}.github.com", id="template-braces"),
    pytest.param("*.github.com", id="wildcard-label"),
    pytest.param("api*.github.com", id="mixed-wildcard-label"),
)


def _request_headers(headers, host_header):
    return headers() if host_header is None else headers(("Host", host_header))


def _assert_authority_error(
    exc_info,
    *,
    reason,
    sni,
    request_host,
    host_header,
    request_port,
    fallback_url,
):
    error = exc_info.value
    assert error.reason == reason
    assert error.sni == sni
    assert error.request_host == request_host
    assert error.host_header == host_header
    assert error.request_port == request_port
    assert error.fallback_url == fallback_url


class TestTrustedAuthorityRejection:
    def test_https_rejects_host_sni_mismatch(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="attacker.example.com",
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="authority_mismatch",
            sni="attacker.example.com",
            request_host="203.0.113.10",
            host_header="api.example.com",
            request_port=443,
            fallback_url="https://attacker.example.com/v1/data",
        )

    @pytest.mark.parametrize("invalid_hostname", INVALID_IDNA_HOSTNAME_CASES)
    def test_rejects_invalid_idna_host_authority(self, real_flow, headers, invalid_hostname):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", invalid_hostname)),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_authority",
            sni="api.github.com",
            request_host="203.0.113.10",
            host_header=invalid_hostname,
            request_port=443,
            fallback_url="https://api.github.com/repos",
        )

    @pytest.mark.parametrize("invalid_hostname", INVALID_IDNA_HOSTNAME_CASES)
    def test_rejects_invalid_idna_sni(self, real_flow, headers, invalid_hostname):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni=invalid_hostname,
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_sni",
            sni=invalid_hostname,
            request_host="203.0.113.10",
            host_header="api.github.com",
            request_port=443,
            fallback_url="https://203.0.113.10/repos",
        )

    @pytest.mark.parametrize("invalid_hostname", _INVALID_TRUSTED_HOSTNAME_CASES)
    def test_rejects_invalid_trusted_host_authority(self, real_flow, headers, invalid_hostname):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", invalid_hostname)),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_authority",
            sni="api.github.com",
            request_host="203.0.113.10",
            host_header=invalid_hostname,
            request_port=443,
            fallback_url="https://api.github.com/repos",
        )

    @pytest.mark.parametrize("invalid_hostname", _INVALID_TRUSTED_HOSTNAME_CASES)
    def test_rejects_invalid_trusted_sni(self, real_flow, headers, invalid_hostname):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni=invalid_hostname,
            path="/repos",
            request_headers=headers(("Host", invalid_hostname)),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_sni",
            sni=invalid_hostname,
            request_host="203.0.113.10",
            host_header=invalid_hostname,
            request_port=443,
            fallback_url="https://203.0.113.10/repos",
        )

    @pytest.mark.parametrize(
        ("request_port", "host_header", "expected_reason", "expected_fallback_url"),
        [
            pytest.param(
                443, None, "missing_authority", "https://api.github.com/repos", id="missing"
            ),
            pytest.param(443, "", "missing_authority", "https://api.github.com/repos", id="empty"),
            pytest.param(
                8443,
                "",
                "missing_authority",
                "https://api.github.com:8443/repos",
                id="empty-non-default-port",
            ),
            pytest.param(
                443,
                "api.github.com:bad",
                "invalid_authority",
                "https://api.github.com/repos",
                id="nonnumeric-port",
            ),
            pytest.param(
                443,
                "api.github.com:\uff14\uff14\uff13",
                "invalid_authority",
                "https://api.github.com/repos",
                id="fullwidth-port-digits",
            ),
            pytest.param(
                443,
                "api.github.com:\u0664\u0664\u0663",
                "invalid_authority",
                "https://api.github.com/repos",
                id="arabic-indic-port-digits",
            ),
            pytest.param(
                443,
                "api.github.com:\u0967\u0968\u0969",
                "invalid_authority",
                "https://api.github.com/repos",
                id="devanagari-port-digits",
            ),
            pytest.param(
                443,
                "api.github.com:" + ("9" * 128),
                "invalid_authority",
                "https://api.github.com/repos",
                id="oversized-port",
            ),
            pytest.param(
                443,
                "api.github.com:00065536",
                "invalid_authority",
                "https://api.github.com/repos",
                id="port-out-of-range",
            ),
            pytest.param(
                443,
                "[2001:db8::1]:\uff14\uff14\uff13",
                "invalid_authority",
                "https://api.github.com/repos",
                id="ipv6-fullwidth-port",
            ),
            pytest.param(
                443,
                "[::1]junk",
                "invalid_authority",
                "https://api.github.com/repos",
                id="ipv6-trailing-junk",
            ),
            pytest.param(
                443,
                "[fe80::1%25eth0]",
                "invalid_authority",
                "https://api.github.com/repos",
                id="ipv6-zone-id",
            ),
            pytest.param(
                8443,
                "api.github.com:bad",
                "invalid_authority",
                "https://api.github.com:8443/repos",
                id="nonnumeric-port-non-default-request",
            ),
        ],
    )
    def test_rejects_invalid_host_authority(
        self,
        real_flow,
        headers,
        request_port,
        host_header,
        expected_reason,
        expected_fallback_url,
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            port=request_port,
            sni="api.github.com",
            path="/repos",
            request_headers=_request_headers(headers, host_header),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason=expected_reason,
            sni="api.github.com",
            request_host="203.0.113.10",
            host_header=host_header,
            request_port=request_port,
            fallback_url=expected_fallback_url,
        )

    @pytest.mark.parametrize(
        "host_header",
        [
            pytest.param("[127.0.0.1]", id="bracketed-ipv4"),
            pytest.param("[127.0.0.1]:443", id="bracketed-ipv4-default-port"),
        ],
    )
    def test_rejects_bracketed_ipv4_host_authority(self, real_flow, headers, host_header):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="127.0.0.1",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_authority",
            sni="127.0.0.1",
            request_host="203.0.113.10",
            host_header=host_header,
            request_port=443,
            fallback_url="https://127.0.0.1/repos",
        )

    def test_rejects_unbracketed_ipv6_host_authority(self, real_flow, headers):
        flow = real_flow(
            with_response=False,
            host="2001:db8::1",
            port=8443,
            sni="2001:db8::1",
            path="/repos",
            request_headers=headers(("Host", "2001:db8::1")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_authority",
            sni="2001:db8::1",
            request_host="2001:db8::1",
            host_header="2001:db8::1",
            request_port=8443,
            fallback_url="https://[2001:db8::1]:8443/repos",
        )

    @pytest.mark.parametrize(
        ("request_host", "request_port", "raw_sni", "expected_sni", "expected_fallback_url"),
        [
            pytest.param(
                "203.0.113.10",
                443,
                None,
                None,
                "https://203.0.113.10/repos",
                id="none",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "   ",
                "",
                "https://203.0.113.10/repos",
                id="blank",
            ),
            pytest.param(
                "203.0.113.10",
                8443,
                None,
                None,
                "https://203.0.113.10:8443/repos",
                id="none-non-default-port",
            ),
            pytest.param(
                "2001:db8::1",
                8443,
                None,
                None,
                "https://[2001:db8::1]:8443/repos",
                id="ipv6-request-host",
            ),
        ],
    )
    def test_rejects_missing_https_sni(
        self,
        real_flow,
        headers,
        request_host,
        request_port,
        raw_sni,
        expected_sni,
        expected_fallback_url,
    ):
        flow = real_flow(
            with_response=False,
            host=request_host,
            port=request_port,
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )
        flow.client_conn.sni = raw_sni

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="missing_sni",
            sni=expected_sni,
            request_host=request_host,
            host_header="api.github.com",
            request_port=request_port,
            fallback_url=expected_fallback_url,
        )

    @pytest.mark.parametrize(
        ("request_host", "request_port", "raw_sni", "expected_fallback_url"),
        [
            pytest.param(
                "203.0.113.10",
                8443,
                ONLY_DOTS_HOSTNAME,
                "https://203.0.113.10:8443/repos",
                id="dots-non-default-port",
            ),
            pytest.param(
                "203.0.113.10", 443, "\ud800", "https://203.0.113.10/repos", id="surrogate"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "api.github.com:443",
                "https://203.0.113.10/repos",
                id="sni-with-port",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "fe80::1%25eth0",
                "https://203.0.113.10/repos",
                id="ipv6-zone-id",
            ),
            pytest.param(
                "2001:db8::1",
                8443,
                ONLY_DOTS_HOSTNAME,
                "https://[2001:db8::1]:8443/repos",
                id="ipv6-request-host",
            ),
        ],
    )
    def test_rejects_invalid_https_sni(
        self,
        real_flow,
        headers,
        request_host,
        request_port,
        raw_sni,
        expected_fallback_url,
    ):
        flow = real_flow(
            with_response=False,
            host=request_host,
            port=request_port,
            sni=raw_sni,
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_sni",
            sni=raw_sni,
            request_host=request_host,
            host_header="api.github.com",
            request_port=request_port,
            fallback_url=expected_fallback_url,
        )

    @pytest.mark.parametrize(
        ("request_port", "host_header", "expected_fallback_url"),
        [
            pytest.param(
                443,
                "api.github.com:444",
                "https://api.github.com/repos",
                id="default-request-nondefault-host",
            ),
            pytest.param(
                8443,
                "api.github.com:443",
                "https://api.github.com:8443/repos",
                id="nondefault-request-default-host",
            ),
        ],
    )
    def test_rejects_host_authority_port_mismatch(
        self, real_flow, headers, request_port, host_header, expected_fallback_url
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            port=request_port,
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="authority_port_mismatch",
            sni="api.github.com",
            request_host="203.0.113.10",
            host_header=host_header,
            request_port=request_port,
            fallback_url=expected_fallback_url,
        )

    @pytest.mark.parametrize(
        (
            "request_port",
            "request_authority",
            "expected_reason",
            "expected_fallback_url",
        ),
        [
            pytest.param(
                443,
                "attacker.example.com",
                "authority_mismatch",
                "https://api.github.com/repos",
                id="host-mismatch",
            ),
            pytest.param(
                443,
                "api.github.com:bad",
                "invalid_authority",
                "https://api.github.com/repos",
                id="malformed-port",
            ),
            pytest.param(
                443,
                "api.github.com:444",
                "authority_port_mismatch",
                "https://api.github.com/repos",
                id="port-mismatch",
            ),
            pytest.param(
                8443,
                "api.github.com",
                "authority_port_mismatch",
                "https://api.github.com:8443/repos",
                id="implicit-default-port-mismatch",
            ),
        ],
    )
    def test_rejects_invalid_http1_request_target_authority(
        self,
        real_flow,
        headers,
        request_port,
        request_authority,
        expected_reason,
        expected_fallback_url,
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            port=request_port,
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )
        flow.request.authority = request_authority

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        assert flow.request.http_version == "HTTP/1.1"
        assert flow.request.authority == request_authority
        _assert_authority_error(
            exc_info,
            reason=expected_reason,
            sni="api.github.com",
            request_host="203.0.113.10",
            host_header="api.github.com",
            request_port=request_port,
            fallback_url=expected_fallback_url,
        )
