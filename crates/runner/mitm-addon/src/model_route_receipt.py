"""Carry a proxy-signed VM0 model route across requests in one run."""

import base64
import binascii
import hashlib
import hmac
from dataclasses import dataclass

from mitmproxy import http

import flow_metadata

RUN_ID_HEADER = "x-vm0-run-id"
RECEIPT_HEADER = "x-vm0-route-receipt"
SIGNATURE_HEADER = "x-vm0-route-signature"
_SIGNATURE_DOMAIN = b"vm0-model-route-receipt-v1\0"
_VM0_MODEL_FIREWALL = "model-provider:vm0-model"
_MAX_RECEIPT_BYTES = 2048


@dataclass(frozen=True)
class _SignedRouteReceipt:
    receipt: str
    signature: str


_receipts_by_run_id: dict[str, _SignedRouteReceipt] = {}


def apply_cached_route_headers(flow: http.HTTPFlow) -> None:
    """Inject the run ID and its cached route after trusted firewall auth."""
    if flow_metadata.firewall_name(flow.metadata) != _VM0_MODEL_FIREWALL:
        return
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    flow.request.headers[RUN_ID_HEADER] = run_id
    for header in (RECEIPT_HEADER, SIGNATURE_HEADER):
        if header in flow.request.headers:
            del flow.request.headers[header]

    cached = _receipts_by_run_id.get(run_id)
    if cached is None:
        return
    flow.request.headers[RECEIPT_HEADER] = cached.receipt
    flow.request.headers[SIGNATURE_HEADER] = cached.signature


def capture_signed_route_receipt(flow: http.HTTPFlow) -> bool:
    """Verify, consume, and retain a route receipt for later run requests."""
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
    if flow_metadata.firewall_name(flow.metadata) != _VM0_MODEL_FIREWALL:
        return False
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return False

    authorization_values = flow.request.headers.get_all("authorization")
    if len(authorization_values) != 1:
        return False
    token = _bearer_token(authorization_values[0])
    if token is None:
        return False

    receipt = receipt_values[0]
    if not receipt or len(receipt) > _MAX_RECEIPT_BYTES:
        return False
    receipt_bytes = _ascii_bytes(receipt)
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
    _receipts_by_run_id[run_id] = _SignedRouteReceipt(
        receipt=receipt,
        signature=signature_values[0],
    )
    return True


def evict_stale_run_ids(active_run_ids: set[str]) -> None:
    """Drop route receipts after their runs leave the runner registry."""
    for run_id in _receipts_by_run_id.keys() - active_run_ids:
        del _receipts_by_run_id[run_id]


def reset_cache() -> None:
    """Clear all cached route receipts."""
    _receipts_by_run_id.clear()


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
