"""Tests for URL and logging utility functions."""

import json

from mitmproxy.test import tflow, tutils

from logging_utils import log_proxy_entry
from url_utils import get_original_url


class TestGetOriginalUrl:
    def test_https_default_port(self, real_flow):
        flow = real_flow(host="example.com", port=443)
        assert get_original_url(flow) == "https://example.com/"

    def test_http_default_port(self):
        # real_flow hardcodes scheme=https; build a cleartext flow directly.
        flow = tflow.tflow(req=tutils.treq(scheme=b"http", host=b"example.com", port=80, path=b"/"))
        assert get_original_url(flow) == "http://example.com/"

    def test_https_non_standard_port(self, real_flow):
        # Regression for #10082: scheme must come from the TLS handshake,
        # not from the destination port. On :8443 the old code inferred
        # http:// and firewall rules written against https:// stopped
        # matching.
        flow = real_flow(host="example.com", port=8443)
        assert get_original_url(flow) == "https://example.com:8443/"

    def test_non_standard_port_preserved_when_host_header_lacks_port(self, real_flow):
        # The Host header (``example.com``) does not carry the port, but
        # the connection is on :8443. The reconstructed URL must still
        # include :8443 so firewall rules can match the actual target.
        # mitmproxy's ``pretty_url`` would drop the port here because it
        # reads the Host header; we intentionally use ``port`` instead.
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
