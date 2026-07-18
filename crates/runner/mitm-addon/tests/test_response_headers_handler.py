"""Tests for the mitm addon responseheaders hook."""

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_usage_pricing
from tests.flow_helpers import header_map, response_stream
from tests.model_provider_flow_helpers import RealFlowFactory, signed_usage_pricing_headers

_FIXED_TIME = 1_750_000_000


def _signed_pricing_flow(
    real_flow: RealFlowFactory,
    issued_at: object,
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host="model.vm0.ai")
    flow.request.headers["authorization"] = "Bearer proxy-secret"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(signed_usage_pricing_headers(issued_at=issued_at)),
    )
    return flow


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

    @pytest.mark.parametrize(
        "issued_at",
        [_FIXED_TIME - 300, _FIXED_TIME + 300],
        ids=["oldest-accepted", "furthest-future-accepted"],
    )
    def test_accepts_and_strips_signed_model_usage_pricing_at_clock_skew_boundary(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        issued_at: int,
    ) -> None:
        monkeypatch.setattr(model_usage_pricing.time, "time", lambda: _FIXED_TIME)
        flow = _signed_pricing_flow(real_flow, issued_at)

        mitm_addon.responseheaders(flow)

        assert flow.metadata[metadata_keys.MODEL_USAGE_PRICING] == {
            "unitSize": 1_000_000,
            "unitPrices": {
                "tokens.input": 1000,
                "tokens.cache_read": 100,
                "tokens.cache_creation": 1250,
                "tokens.output": 6000,
            },
        }
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        "issued_at",
        [_FIXED_TIME - 301, _FIXED_TIME + 301],
        ids=["too-old", "too-far-future"],
    )
    def test_rejects_and_strips_signed_model_usage_pricing_outside_clock_skew(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        issued_at: int,
    ) -> None:
        monkeypatch.setattr(model_usage_pricing.time, "time", lambda: _FIXED_TIME)
        flow = _signed_pricing_flow(real_flow, issued_at)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        "issued_at",
        [True, str(_FIXED_TIME)],
        ids=["boolean", "string"],
    )
    def test_rejects_and_strips_invalid_signed_model_usage_pricing_issued_at(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        issued_at: object,
    ) -> None:
        monkeypatch.setattr(model_usage_pricing.time, "time", lambda: _FIXED_TIME)
        flow = _signed_pricing_flow(real_flow, issued_at)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    def test_rejects_signed_model_usage_pricing_from_other_provider(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(signed_usage_pricing_headers()),
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    def test_rejects_invalid_model_usage_pricing_signature(self, real_flow):
        flow = real_flow(with_response=False, host="model.vm0.ai")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "x-vm0-usage-pricing": "invalid",
                    "x-vm0-usage-pricing-signature": "invalid",
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    def test_rejects_non_ascii_model_usage_pricing(self, real_flow):
        flow = real_flow(with_response=False, host="model.vm0.ai")
        flow.request.headers["authorization"] = "Bearer proxy-secret"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "x-vm0-usage-pricing": "prïcing",
                    "x-vm0-usage-pricing-signature": "aW52YWxpZA",
                }
            ),
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers
