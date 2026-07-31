"""Request body decoding policy for connector billing inspection."""

import zlib
from typing import Literal

from mitmproxy import http

from body_limits import REQUEST_BODY_BILLING_INSPECTION_LIMIT


def _decode_zlib_request_body_for_billing(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> bytes | None:
    """Decode every gzip member or one deflate stream under one output cap."""
    wbits_options = (
        (16 + zlib.MAX_WBITS,) if encoding == "gzip" else (zlib.MAX_WBITS, -zlib.MAX_WBITS)
    )
    for wbits in wbits_options:
        remaining = data
        decoded = bytearray()
        while remaining:
            obj = zlib.decompressobj(wbits)
            try:
                decoded.extend(
                    obj.decompress(
                        remaining,
                        max_length=max_output - len(decoded) + 1,
                    )
                )
            except zlib.error:
                break
            if len(decoded) > max_output:
                return None
            if not obj.eof:
                break
            remaining = obj.unused_data
            if not remaining:
                return bytes(decoded)
            if encoding != "gzip":
                break
    return None


def decode_request_body_for_billing(
    raw_content: bytes | None,
    headers: http.Headers,
    *,
    max_raw: int = REQUEST_BODY_BILLING_INSPECTION_LIMIT,
    max_decoded: int = REQUEST_BODY_BILLING_INSPECTION_LIMIT,
) -> bytes | None:
    """Decode a request body for conservative billing inspection.

    Unlike response capture helpers, billing must fail closed: unsupported,
    invalid, incomplete, or oversized encoded bodies are treated as
    uninspectable rather than falling back to raw bytes. Complete gzip member
    sequences share one decoded-output budget; deflate accepts one zlib-wrapped
    or raw stream.
    """
    if not raw_content:
        return None
    if len(raw_content) > max_raw:
        return None

    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return raw_content if len(raw_content) <= max_decoded else None
    if encoding == "gzip":
        return _decode_zlib_request_body_for_billing(raw_content, "gzip", max_decoded)
    if encoding == "deflate":
        return _decode_zlib_request_body_for_billing(raw_content, "deflate", max_decoded)
    return None
