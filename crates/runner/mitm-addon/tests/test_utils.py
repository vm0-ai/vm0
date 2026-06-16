"""Tests for URL utility functions."""

import pytest

from url_utils import AuthorityValidationError, get_original_url


class TestGetOriginalUrl:
    @pytest.mark.parametrize(
        ("scheme", "port", "expected_url"),
        [
            ("https", 443, "https://example.com/"),
            ("http", 80, "http://example.com/"),
            ("https", 8443, "https://example.com:8443/"),
            ("http", 8080, "http://example.com:8080/"),
            ("https", 80, "https://example.com:80/"),
            ("http", 443, "http://example.com:443/"),
        ],
    )
    def test_omits_only_scheme_default_ports(self, real_flow, scheme, port, expected_url):
        flow = real_flow(host="example.com", port=port, scheme=scheme)
        assert get_original_url(flow) == expected_url

    def test_https_non_standard_port(self, real_flow):
        # Pins two invariants at once for the #10082 regression:
        # - scheme comes from the TLS handshake, not from the port (so
        #   :8443 stays ``https://``, not ``http://`` as before the fix);
        # - the destination port is included even when the Host header
        #   has no port (the Host-lacks-port precondition is asserted
        #   below — mitmproxy's ``pretty_url`` would drop the port here,
        #   which is why we don't use it).
        flow = real_flow(host="example.com", port=8443)
        assert flow.request.headers.get("Host") == "example.com"
        assert get_original_url(flow) == "https://example.com:8443/"

    def test_with_path_and_query(self, real_flow):
        flow = real_flow(host="api.example.com", port=443, path="/v1/data?key=val")
        assert get_original_url(flow) == "https://api.example.com/v1/data?key=val"

    def test_https_uses_sni_for_transparent_destination(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="api.example.com",
            path="/v1/data?key=val",
            request_headers=headers(("Host", "api.example.com")),
        )
        assert get_original_url(flow) == "https://api.example.com/v1/data?key=val"

    def test_https_rejects_host_sni_mismatch(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="attacker.example.com",
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )
        with pytest.raises(AuthorityValidationError) as exc_info:
            get_original_url(flow)

        assert exc_info.value.reason == "authority_mismatch"

    def test_https_accepts_trailing_dot_authority_equivalence(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="api.example.com.",
            path="/v1/data",
            request_headers=headers(("Host", "API.EXAMPLE.COM.")),
        )
        assert get_original_url(flow) == "https://api.example.com/v1/data"

    def test_http_uses_request_host_not_host_header(self, real_flow, headers):
        flow = real_flow(
            scheme="http",
            host="203.0.113.10",
            port=80,
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )
        assert get_original_url(flow) == "http://203.0.113.10/v1/data"

    def test_http_brackets_ipv6_request_host(self, real_flow, headers):
        flow = real_flow(
            scheme="http",
            host="2001:db8::1",
            port=8080,
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )
        assert get_original_url(flow) == "http://[2001:db8::1]:8080/v1/data"

    def test_https_brackets_ipv6_sni(self, real_flow, headers):
        flow = real_flow(
            host="2001:db8::1",
            port=8443,
            sni="2001:db8::1",
            path="/v1/data",
            request_headers=headers(("Host", "[2001:db8::1]")),
        )
        assert get_original_url(flow) == "https://[2001:db8::1]:8443/v1/data"
