"""Verification for opaque model usage billing receipts."""

import base64
import binascii
import hashlib
import hmac
import json
import time

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from usage.model_tokens import MODEL_USAGE_CATEGORIES

RECEIPT_HEADER = "x-vm0-usage-receipt"
SIGNATURE_HEADER = "x-vm0-usage-signature"
PRICING_HEADER = "x-vm0-usage-pricing"
PRICING_SIGNATURE_HEADER = "x-vm0-usage-pricing-signature"
_SIGNATURE_DOMAIN = b"vm0-model-usage-receipt-v1\0"
_PRICING_SIGNATURE_DOMAIN = b"vm0-model-usage-pricing-v1\0"
_MAX_RECEIPT_BYTES = 1024
_MAX_PRICING_BYTES = 2048
_MAX_CLOCK_SKEW_SECONDS = 300
_MAX_BILLING_SKU_LENGTH = 100


def apply_signed_usage_receipt(flow: http.HTTPFlow) -> bool:
    """Verify, consume, and hide an opaque billing SKU from a proxy response."""
    response = flow.response
    if response is None:
        return False

    receipt_values = response.headers.get_all(RECEIPT_HEADER)
    signature_values = response.headers.get_all(SIGNATURE_HEADER)
    if RECEIPT_HEADER in response.headers:
        del response.headers[RECEIPT_HEADER]
    if SIGNATURE_HEADER in response.headers:
        del response.headers[SIGNATURE_HEADER]

    if len(receipt_values) != 1 or len(signature_values) != 1:
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

    encoded_receipt = receipt_values[0]
    if not encoded_receipt or len(encoded_receipt) > _MAX_RECEIPT_BYTES:
        return False
    receipt_bytes = _ascii_bytes(encoded_receipt)
    if receipt_bytes is None:
        return False
    signature = _decode_base64url(signature_values[0])
    if signature is None:
        return False
    expected = hmac.new(
        token.encode("utf-8"),
        _SIGNATURE_DOMAIN + receipt_bytes,
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected):
        return False

    receipt = _decode_receipt(encoded_receipt)
    if receipt is None:
        return False
    flow.metadata[metadata_keys.MODEL_USAGE_BILLING_SKU] = receipt["billingSku"]
    return True


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
    billing_sku = flow_metadata.model_usage_billing_sku(flow.metadata)
    if billing_sku is None:
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
    if pricing is None or pricing[0] != billing_sku:
        return False
    flow.metadata[metadata_keys.MODEL_USAGE_PRICING] = {
        "billingSku": pricing[0],
        "unitSize": pricing[1],
        "unitPrices": pricing[2],
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


def _decode_receipt(value: str) -> dict[str, object] | None:
    decoded = _decode_base64url(value)
    if decoded is None:
        return None
    try:
        receipt = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(receipt, dict) or set(receipt) != {"version", "billingSku", "issuedAt"}:
        return None
    if receipt["version"] != 1:
        return None
    billing_sku = receipt["billingSku"]
    if not isinstance(billing_sku, str) or not 1 <= len(billing_sku) <= _MAX_BILLING_SKU_LENGTH:
        return None
    issued_at = receipt["issuedAt"]
    if not isinstance(issued_at, int) or isinstance(issued_at, bool):
        return None
    if abs(int(time.time()) - issued_at) > _MAX_CLOCK_SKEW_SECONDS:
        return None
    return receipt


def _decode_pricing(value: str) -> tuple[str, int, dict[str, int]] | None:
    decoded = _decode_base64url(value)
    if decoded is None:
        return None
    try:
        pricing = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(pricing, dict) or set(pricing) != {
        "version",
        "billingSku",
        "issuedAt",
        "unitSize",
        "unitPrices",
    }:
        return None
    if pricing["version"] != 1:
        return None
    billing_sku = pricing["billingSku"]
    if not isinstance(billing_sku, str) or not 1 <= len(billing_sku) <= _MAX_BILLING_SKU_LENGTH:
        return None
    issued_at = pricing["issuedAt"]
    if not isinstance(issued_at, int) or isinstance(issued_at, bool):
        return None
    if abs(int(time.time()) - issued_at) > _MAX_CLOCK_SKEW_SECONDS:
        return None
    unit_size = pricing["unitSize"]
    if not isinstance(unit_size, int) or isinstance(unit_size, bool) or unit_size <= 0:
        return None
    raw_unit_prices = pricing["unitPrices"]
    if not isinstance(raw_unit_prices, dict) or set(raw_unit_prices) != set(MODEL_USAGE_CATEGORIES):
        return None
    unit_prices: dict[str, int] = {}
    for category in MODEL_USAGE_CATEGORIES:
        unit_price = raw_unit_prices[category]
        if not isinstance(unit_price, int) or isinstance(unit_price, bool) or unit_price < 0:
            return None
        unit_prices[category] = unit_price
    return billing_sku, unit_size, unit_prices
