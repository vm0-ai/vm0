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

RECEIPT_HEADER = "x-vm0-usage-receipt"
SIGNATURE_HEADER = "x-vm0-usage-signature"
_SIGNATURE_DOMAIN = b"vm0-model-usage-receipt-v1\0"
_MAX_RECEIPT_BYTES = 1024
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
    if not flow_metadata.firewall_name(flow.metadata).startswith("model-provider:"):
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
    signature = _decode_base64url(signature_values[0])
    if signature is None:
        return False
    expected = hmac.new(
        token.encode("utf-8"),
        _SIGNATURE_DOMAIN + encoded_receipt.encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected):
        return False

    receipt = _decode_receipt(encoded_receipt)
    if receipt is None:
        return False
    flow.metadata[metadata_keys.MODEL_USAGE_BILLING_SKU] = receipt["billingSku"]
    return True


def _bearer_token(value: str) -> str | None:
    if not value.startswith("Bearer "):
        return None
    token = value[len("Bearer ") :].strip()
    return token or None


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
