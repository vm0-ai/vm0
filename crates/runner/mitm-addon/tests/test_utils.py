"""Tests for URL utility functions."""

from unittest.mock import MagicMock

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
