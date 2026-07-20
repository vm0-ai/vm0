"""Signed response-header verification for model token price schedules.

See ``docs/model-usage-pricing-protocol.md`` for the producer/runner contract.
"""

import base64
import binascii
import hashlib
import hmac
import json
import time

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from usage.model_pricing import ModelUsagePricing, parse_model_usage_pricing

PRICING_HEADER = "x-vm0-usage-pricing"
PRICING_SIGNATURE_HEADER = "x-vm0-usage-pricing-signature"
_PRICING_SIGNATURE_DOMAIN = b"vm0-model-usage-pricing-v1\0"
_MAX_PRICING_BYTES = 2048
_MAX_CLOCK_SKEW_SECONDS = 300


def apply_signed_usage_pricing(flow: http.HTTPFlow) -> bool:
    """Verify, consume, and hide a signed model token price schedule."""
    response = flow.response
    if response is None:
        return False

    pricing_values = response.headers.get_all(PRICING_HEADER)
    signature_values = response.headers.get_all(PRICING_SIGNATURE_HEADER)
    if PRICING_HEADER in response.headers:
        del response.headers[PRICING_HEADER]
    if PRICING_SIGNATURE_HEADER in response.headers:
        del response.headers[PRICING_SIGNATURE_HEADER]

    if len(pricing_values) != 1 or len(signature_values) != 1:
        return False
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return False
    if flow_metadata.firewall_name(flow.metadata) != "model-provider:vm0-model":
        return False

    authorization_values = flow.request.headers.get_all("authorization")
    if len(authorization_values) != 1:
        return False
    token = _bearer_token(authorization_values[0])
    if token is None:
        return False

    encoded_pricing = pricing_values[0]
    if not encoded_pricing or len(encoded_pricing) > _MAX_PRICING_BYTES:
        return False
    pricing_bytes = _ascii_bytes(encoded_pricing)
    if pricing_bytes is None:
        return False
    signature = _decode_base64url(signature_values[0])
    if signature is None:
        return False
    expected = hmac.new(
        token.encode("utf-8"),
        _PRICING_SIGNATURE_DOMAIN + pricing_bytes,
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected):
        return False

    pricing = _decode_pricing(encoded_pricing)
    if pricing is None:
        return False
    flow.metadata[metadata_keys.MODEL_USAGE_PRICING] = {
        "unitSize": pricing.unit_size,
        "unitPrices": pricing.unit_prices,
    }
    return True


def _bearer_token(value: str) -> str | None:
    if not value.startswith("Bearer "):
        return None
    token = value[len("Bearer ") :].strip()
    return token or None


def _ascii_bytes(value: str) -> bytes | None:
    try:
        return value.encode("ascii")
    except UnicodeEncodeError:
        return None


def _decode_base64url(value: str) -> bytes | None:
    if not value:
        return None
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        return None


def _decode_pricing(value: str) -> ModelUsagePricing | None:
    decoded = _decode_base64url(value)
    if decoded is None:
        return None
    try:
        pricing = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(pricing, dict) or set(pricing) != {
        "version",
        "issuedAt",
        "unitSize",
        "unitPrices",
    }:
        return None
    if pricing["version"] != 1:
        return None
    issued_at = pricing["issuedAt"]
    if not isinstance(issued_at, int) or isinstance(issued_at, bool):
        return None
    if abs(int(time.time()) - issued_at) > _MAX_CLOCK_SKEW_SECONDS:
        return None

    return parse_model_usage_pricing(pricing["unitSize"], pricing["unitPrices"])
