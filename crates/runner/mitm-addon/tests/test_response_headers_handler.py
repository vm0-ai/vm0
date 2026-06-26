"""Tests for the mitm addon responseheaders hook."""

from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import header_map, response_stream


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook contract."""

    def test_enables_streaming_with_buffer(self, real_flow):
        """All responses should be streamed via a buffer callback."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert isinstance(flow.metadata[metadata_keys.STREAM_BUFFER], bytearray)
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

    def test_capture_body_also_streams(self, real_flow):
        """When capture_body is set, streaming should still be enabled."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

    def test_no_response_is_noop(self, real_flow):
        """Flow without response should not raise."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)
