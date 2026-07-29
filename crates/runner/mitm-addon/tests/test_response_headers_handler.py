"""Tests for the mitm addon responseheaders hook."""

import base64
from types import SimpleNamespace

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_usage_pricing
from tests.flow_helpers import header_map, response_stream
from tests.model_provider_flow_helpers import (
    RealFlowFactory,
    signed_raw_usage_pricing_headers,
    signed_usage_pricing_headers,
)

_FIXED_TIME = 1_750_000_000


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _fix_pricing_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        model_usage_pricing,
        "time",
        SimpleNamespace(time=lambda: _FIXED_TIME),
    )


def _signed_pricing_flow(
    real_flow: RealFlowFactory,
    issued_at: object,
    *,
    unit_size: object = 1_000_000,
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host="model.vm0.ai")
    flow.request.headers["authorization"] = "Bearer proxy-secret"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:vm0-model"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(signed_usage_pricing_headers(issued_at=issued_at, unit_size=unit_size)),
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
        _fix_pricing_clock(monkeypatch)
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
        "firewall_billable",
        [False, None],
        ids=["false", "absent"],
    )
    def test_rejects_and_strips_signed_model_usage_pricing_without_billable_context(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        firewall_billable: bool | None,
    ) -> None:
        _fix_pricing_clock(monkeypatch)
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME)
        if firewall_billable is None:
            del flow.metadata[metadata_keys.FIREWALL_BILLABLE]
        else:
            flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        "authorization_values",
        [
            (),
            ("Bearer proxy-secret", "Bearer proxy-secret"),
            ("Basic proxy-secret",),
            ("Bearer ",),
        ],
        ids=["missing", "duplicate", "non-bearer", "empty-bearer"],
    )
    def test_rejects_and_strips_signed_model_usage_pricing_with_invalid_authorization(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        authorization_values: tuple[str, ...],
    ) -> None:
        _fix_pricing_clock(monkeypatch)
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME)
        del flow.request.headers["authorization"]
        for value in authorization_values:
            flow.request.headers.add("authorization", value)
        assert flow.request.headers.get_all("authorization") == list(authorization_values)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        "duplicate_header",
        ["x-vm0-usage-pricing", "x-vm0-usage-pricing-signature"],
        ids=["pricing", "signature"],
    )
    def test_rejects_and_strips_duplicate_model_usage_pricing_headers(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        duplicate_header: str,
    ) -> None:
        _fix_pricing_clock(monkeypatch)
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME)
        assert flow.response is not None
        flow.response.headers.add(duplicate_header, "duplicate")
        assert len(flow.response.headers.get_all(duplicate_header)) == 2

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        ("price_digits", "encoded_length", "accepted"),
        [(1377, 2048, True), (1378, 2050, False)],
        ids=["maximum", "oversized"],
    )
    def test_enforces_signed_model_usage_pricing_encoded_length(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        price_digits: int,
        encoded_length: int,
        accepted: bool,
    ) -> None:
        _fix_pricing_clock(monkeypatch)
        unit_prices: dict[str, object] = {
            "tokens.input": int("9" * price_digits),
            "tokens.cache_read": 100,
            "tokens.cache_creation": 1250,
            "tokens.output": 6000,
        }
        headers = signed_usage_pricing_headers(
            unit_prices,
            issued_at=_FIXED_TIME,
        )
        assert len(headers["x-vm0-usage-pricing"]) == encoded_length
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME)
        assert flow.response is not None
        flow.response.headers = header_map(headers)

        mitm_addon.responseheaders(flow)

        if accepted:
            assert flow.metadata[metadata_keys.MODEL_USAGE_PRICING] == {
                "unitSize": 1_000_000,
                "unitPrices": unit_prices,
            }
        else:
            assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
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
        _fix_pricing_clock(monkeypatch)
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
        _fix_pricing_clock(monkeypatch)
        flow = _signed_pricing_flow(real_flow, issued_at)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_USAGE_PRICING not in flow.metadata
        assert flow.response is not None
        assert "x-vm0-usage-pricing" not in flow.response.headers
        assert "x-vm0-usage-pricing-signature" not in flow.response.headers

    @pytest.mark.parametrize(
        "unit_size",
        [0, -1, True, "1000000"],
        ids=["zero", "negative", "boolean", "numeric-string"],
    )
    def test_rejects_and_strips_invalid_signed_model_usage_pricing_unit_size(
        self,
        real_flow: RealFlowFactory,
        monkeypatch: pytest.MonkeyPatch,
        unit_size: object,
    ) -> None:
        _fix_pricing_clock(monkeypatch)
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME, unit_size=unit_size)

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

    @pytest.mark.parametrize(
        "pricing",
        [
            "invalid!",
            _encode_base64url(b"\xff"),
            _encode_base64url(b"{"),
            _encode_base64url(b"[]"),
            _encode_base64url(b'{"version":1}'),
            _encode_base64url(
                b'{"version":2,"issuedAt":1750000000,"unitSize":1000000,'
                b'"unitPrices":{"tokens.input":1000,"tokens.cache_read":100,'
                b'"tokens.cache_creation":1250,"tokens.output":6000}}'
            ),
        ],
        ids=[
            "invalid-base64",
            "invalid-utf8",
            "invalid-json",
            "non-object",
            "wrong-shape",
            "unsupported-version",
        ],
    )
    def test_rejects_and_strips_hmac_valid_malformed_model_usage_pricing(
        self,
        real_flow: RealFlowFactory,
        pricing: str,
    ) -> None:
        flow = _signed_pricing_flow(real_flow, _FIXED_TIME)
        assert flow.response is not None
        flow.response.headers = header_map(signed_raw_usage_pricing_headers(pricing))

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
