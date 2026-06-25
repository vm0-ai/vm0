"""Trusted request authority rejection URL utility tests."""

import pytest

from url_utils import AuthorityValidationError, get_original_url, get_trusted_authority


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
    def test_get_original_url_propagates_authority_validation_error(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="attacker.example.com",
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_original_url(flow)

        assert exc_info.value.reason == "authority_mismatch"

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

    def test_rejects_idna_compatibility_sni_alias(self, real_flow, headers):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="\uff21.example",
            path="/repos",
            request_headers=headers(("Host", "a.example")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_sni",
            sni="\uff21.example",
            request_host="203.0.113.10",
            host_header="a.example",
            request_port=443,
            fallback_url="https://203.0.113.10/repos",
        )

    def test_rejects_multiple_trailing_dot_sni(self, real_flow, headers):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="api.github.com..",
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_sni",
            sni="api.github.com..",
            request_host="203.0.113.10",
            host_header="api.github.com",
            request_port=443,
            fallback_url="https://203.0.113.10/repos",
        )

    def test_rejects_idna_compatibility_host_alias(self, real_flow, headers):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="a.example",
            path="/repos",
            request_headers=headers(("Host", "\uff21.example")),
        )

        with pytest.raises(AuthorityValidationError) as exc_info:
            get_trusted_authority(flow)

        _assert_authority_error(
            exc_info,
            reason="invalid_authority",
            sni="a.example",
            request_host="203.0.113.10",
            host_header="\uff21.example",
            request_port=443,
            fallback_url="https://a.example/repos",
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
                "api.github.com..",
                "invalid_authority",
                "https://api.github.com/repos",
                id="multiple-trailing-dots",
            ),
            pytest.param(
                443,
                "api%2egithub.com",
                "invalid_authority",
                "https://api.github.com/repos",
                id="percent-encoded-dot",
            ),
            pytest.param(
                443,
                "b%C3%BCcher.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="percent-encoded-unicode",
            ),
            pytest.param(
                443,
                "{api}.github.com",
                "invalid_authority",
                "https://api.github.com/repos",
                id="template-braces",
            ),
            pytest.param(
                443,
                "xn--.com",
                "invalid_authority",
                "https://api.github.com/repos",
                id="empty-punycode-label",
            ),
            pytest.param(
                443,
                "xn--a.com",
                "invalid_authority",
                "https://api.github.com/repos",
                id="short-punycode",
            ),
            pytest.param(
                443,
                "xn--zzzz.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-punycode",
            ),
            pytest.param(
                443,
                "xn--ph7c.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="disallowed-punycode",
            ),
            pytest.param(
                443,
                "\u4f8b\uff1a\u5b50.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="fullwidth-colon",
            ),
            pytest.param(
                443,
                "\u4f8b\uff0c\u5b50.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="fullwidth-comma",
            ),
            pytest.param(
                443,
                "\u034f.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="combining-grapheme-joiner",
            ),
            pytest.param(
                443,
                "\u0301.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="leading-combining-mark",
            ),
            pytest.param(
                443,
                "\ufe0f.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="variation-selector",
            ),
            pytest.param(
                443,
                "xn--rld.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-rld",
            ),
            pytest.param(
                443,
                "xn--f09a.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-f09a",
            ),
            pytest.param(
                443,
                "xn--hsg.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-hsg",
            ),
            pytest.param(
                443,
                "xn--43f.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-43f",
            ),
            pytest.param(
                443,
                "\u00a8.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="diaeresis",
            ),
            pytest.param(
                443,
                "\u10a0.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="georgian-asomtavruli",
            ),
            pytest.param(
                443,
                "\u04c0.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="cyrillic-palochka",
            ),
            pytest.param(
                443,
                "\ufe12.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="presentation-comma",
            ),
            pytest.param(
                443,
                "\ufffc.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="object-replacement",
            ),
            pytest.param(
                443,
                "\u0754\u3d20.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-arabic-context",
            ),
            pytest.param(
                443,
                "a\u0754b.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="arabic-between-latin",
            ),
            pytest.param(
                443,
                "\u25a5\u33d5\u067a.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-script-context",
            ),
            pytest.param(
                443,
                "\u28a8\u17b5.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="invalid-khmer-context",
            ),
            pytest.param(
                443,
                "\u0663a.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="arabic-digit-before-latin",
            ),
            pytest.param(
                443,
                "\u0663!.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="arabic-digit-symbol",
            ),
            pytest.param(
                443,
                "\u0663\u067aa.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="arabic-digit-arabic-latin",
            ),
            pytest.param(
                443,
                "a\u0663b.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="latin-arabic-digit-latin",
            ),
            pytest.param(
                443,
                "a\u0663\u0664.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="latin-arabic-digits",
            ),
            pytest.param(
                443,
                "1\u0663.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="ascii-and-arabic-digits",
            ),
            pytest.param(
                443,
                "!\u0663!.example",
                "invalid_authority",
                "https://api.github.com/repos",
                id="punctuation-arabic-digit",
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
            pytest.param("0177.0.0.1", id="octal-ipv4"),
            pytest.param("127。0。0。1", id="ideographic-dot-ipv4"),
            pytest.param("127.0.0.1。", id="trailing-ideographic-dot-ipv4"),
            pytest.param("\uff11\uff12\uff17.\uff10.\uff10.\uff11", id="fullwidth-ipv4"),
        ],
    )
    def test_rejects_noncanonical_ipv4_host_authority(self, real_flow, headers, host_header):
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
            pytest.param("203.0.113.10", 443, "...", "https://203.0.113.10/repos", id="dots"),
            pytest.param(
                "203.0.113.10",
                8443,
                "...",
                "https://203.0.113.10:8443/repos",
                id="dots-non-default-port",
            ),
            pytest.param(
                "203.0.113.10", 443, "\ud800", "https://203.0.113.10/repos", id="surrogate"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "xn--.com",
                "https://203.0.113.10/repos",
                id="empty-punycode-label",
            ),
            pytest.param(
                "203.0.113.10", 443, "xn--a.com", "https://203.0.113.10/repos", id="short-punycode"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "xn--ph7c.example",
                "https://203.0.113.10/repos",
                id="disallowed-punycode",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "api%2egithub.com",
                "https://203.0.113.10/repos",
                id="percent-encoded-dot",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "api.github.com:443",
                "https://203.0.113.10/repos",
                id="sni-with-port",
            ),
            pytest.param(
                "203.0.113.10", 443, "0177.0.0.1", "https://203.0.113.10/repos", id="octal-ipv4"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "127。0。0。1",
                "https://203.0.113.10/repos",
                id="ideographic-dot-ipv4",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "127.0.0.1。",
                "https://203.0.113.10/repos",
                id="trailing-ideographic-dot-ipv4",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\uff11\uff12\uff17.\uff10.\uff10.\uff11",
                "https://203.0.113.10/repos",
                id="fullwidth-ipv4",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u4f8b\uff1a\u5b50.example",
                "https://203.0.113.10/repos",
                id="fullwidth-colon",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u212a.example",
                "https://203.0.113.10/repos",
                id="kelvin-sign",
            ),
            pytest.param(
                "203.0.113.10", 443, "\u1e9e.de", "https://203.0.113.10/repos", id="capital-eszett"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u03f2.example",
                "https://203.0.113.10/repos",
                id="lunate-sigma",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u034f.example",
                "https://203.0.113.10/repos",
                id="combining-grapheme-joiner",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u0301.example",
                "https://203.0.113.10/repos",
                id="leading-combining-mark",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "xn--rld.example",
                "https://203.0.113.10/repos",
                id="invalid-rld",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "fe80::1%25eth0",
                "https://203.0.113.10/repos",
                id="ipv6-zone-id",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "xn--zzzz.example",
                "https://203.0.113.10/repos",
                id="invalid-punycode",
            ),
            pytest.param(
                "203.0.113.10", 443, "\u00a8.example", "https://203.0.113.10/repos", id="diaeresis"
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u10a0.example",
                "https://203.0.113.10/repos",
                id="georgian-asomtavruli",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\ufffc.example",
                "https://203.0.113.10/repos",
                id="object-replacement",
            ),
            pytest.param(
                "203.0.113.10",
                443,
                "\u0754\u3d20.example",
                "https://203.0.113.10/repos",
                id="invalid-arabic-context",
            ),
            pytest.param(
                "2001:db8::1",
                8443,
                "...",
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
