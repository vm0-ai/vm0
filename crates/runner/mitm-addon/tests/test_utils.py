"""Tests for URL and logging utility functions."""

import json
from unittest.mock import MagicMock

from logging_utils import log_proxy_entry
from url_utils import get_original_url


def _make_flow(host, port, path="/", scheme=None):
    """Create a minimal mock flow for get_original_url."""
    flow = MagicMock()
    flow.request.pretty_host = host
    flow.request.port = port
    flow.request.path = path
    return flow


class TestGetOriginalUrl:
    def test_https_default_port(self):
        flow = _make_flow("example.com", 443)
        assert get_original_url(flow) == "https://example.com/"

    def test_http_default_port(self):
        flow = _make_flow("example.com", 80)
        assert get_original_url(flow) == "http://example.com/"

    def test_https_non_standard_port(self):
        flow = _make_flow("example.com", 8443)
        assert get_original_url(flow) == "http://example.com:8443/"

    def test_with_path_and_query(self):
        flow = _make_flow("api.example.com", 443, "/v1/data?key=val")
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
