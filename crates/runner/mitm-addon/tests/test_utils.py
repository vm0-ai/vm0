"""Tests for URL and logging utility functions."""

import json

import pytest

from logging_utils import log_proxy_entry
from url_utils import get_original_url


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


class TestLogProxyEntry:
    def test_writes_jsonl(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        log_proxy_entry(proxy_path, "warn", "test message", extra_field="value")
        entry = json.loads((tmp_path / "proxy-test.jsonl").read_text().strip())
        assert entry["level"] == "warn"
        assert entry["message"] == "test message"
        assert entry["extra_field"] == "value"
        assert "timestamp" in entry

    def test_appends_multiple_entries(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        log_proxy_entry(proxy_path, "info", "first")
        log_proxy_entry(proxy_path, "warn", "second")
        lines = (tmp_path / "proxy-test.jsonl").read_text().strip().split("\n")
        assert len(lines) == 2
        assert json.loads(lines[0])["message"] == "first"
        assert json.loads(lines[1])["message"] == "second"

    def test_empty_path_no_op(self, tmp_path):
        log_proxy_entry("", "warn", "should not write")
        assert not list(tmp_path.iterdir())
