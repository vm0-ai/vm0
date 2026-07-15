"""Tests for the mitm addon responseheaders hook."""

import base64
import hashlib
import hmac
import json
import time

from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import header_map, response_stream


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook contract."""

    def test_enables_streaming_without_body_buffer(self, real_flow):
        """Ordinary responses should stream with metrics but no retained prefix."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] == {"total_bytes": 0}
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_capture_body_also_streams(self, real_flow):
        """When capture_body is set, streaming should still be enabled."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] == {"total_bytes": 0}
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

    def test_no_response_is_noop(self, real_flow):
        """Flow without response should not raise."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)

        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata

    def test_accepts_and_strips_signed_model_usage_receipt(self, real_flow):
        flow = real_flow(with_response=False, host="model.vm0.ai")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        receipt = (
            base64.urlsafe_b64encode(
                json.dumps(
                    {
                        "version": 1,
                        "billingSku": "model-standard-v1",
                        "issuedAt": int(time.time()),
                    },
                    separators=(",", ":"),
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(
                    b"proxy-secret",
                    b"vm0-model-usage-receipt-v1\0" + receipt.encode(),
                    hashlib.sha256,
                ).digest()
            )
            .decode()
            .rstrip("=")
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "x-vm0-usage-receipt": receipt,
                    "x-vm0-usage-signature": signature,
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        assert flow.metadata[metadata_keys.MODEL_USAGE_BILLING_SKU] == "model-standard-v1"
        assert "x-vm0-usage-receipt" not in flow.response.headers
        assert "x-vm0-usage-signature" not in flow.response.headers

    def test_rejects_invalid_model_usage_receipt_signature(self, real_flow):
        flow = real_flow(with_response=False, host="model.vm0.ai")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "x-vm0-usage-receipt": "invalid",
                    "x-vm0-usage-signature": "invalid",
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_BILLING_SKU not in flow.metadata
        assert "x-vm0-usage-receipt" not in flow.response.headers
        assert "x-vm0-usage-signature" not in flow.response.headers

    def test_rejects_non_ascii_model_usage_receipt(self, real_flow):
        flow = real_flow(with_response=False, host="model.vm0.ai")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "x-vm0-usage-receipt": "réceipt",
                    "x-vm0-usage-signature": "aW52YWxpZA",
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_BILLING_SKU not in flow.metadata
        assert "x-vm0-usage-receipt" not in flow.response.headers
        assert "x-vm0-usage-signature" not in flow.response.headers
