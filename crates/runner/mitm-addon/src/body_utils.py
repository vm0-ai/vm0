"""Body processing helpers shared between usage extraction and body capture.

Exports:

- ``STREAM_BUFFER_LIMIT`` — 64 KB cap used by the responseheaders streaming
  buffer and by the decompression safety cap.
- Streaming / one-shot decompression for gzip, deflate, br, zstd.
- UTF-8-safe truncation, text/binary content detection and encoding.
- Header redaction for sensitive names (auth, token, cookie, …).
- ``add_capture_fields`` — composes capture-mode log entry fields.
"""

import base64
import contextlib
import zlib
from collections.abc import Callable
from typing import Literal

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import ctx, http

import flow_metadata_keys as metadata_keys

# Cap for non-model-provider response body buffering and decompression output.
STREAM_BUFFER_LIMIT = 64 * 1024  # 64 KB

# UTF-8 byte-boundary markers (RFC 3629).  Continuation bytes match
# ``0b10xxxxxx`` → ``(byte & 0xC0) == _UTF8_CONT_MARK``.  Lead bytes fall
# into four ranges by ``lead < _UTF8_LEAD_MAX_{N}BYTE`` for N = 1..3.
_UTF8_CONT_MARK = 0x80
_UTF8_LEAD_MAX_1BYTE = 0x80  # ASCII: 0xxxxxxx
_UTF8_LEAD_MAX_2BYTE = 0xE0  # 2-byte lead: 110xxxxx
_UTF8_LEAD_MAX_3BYTE = 0xF0  # 3-byte lead: 1110xxxx

# Decompression cap for legacy/test one-shot usage extraction fallbacks.
# Production billable JSON paths use streaming decompression plus selective
# extraction; this remains larger than STREAM_BUFFER_LIMIT for direct helper
# calls while still bounding decompression bombs.
LARGE_RESPONSE_DECOMPRESS_LIMIT = 5 * 1024 * 1024  # 5 MB

# Python's brotli binding has no max-output API, and one process() call can
# still transiently emit multi-MB output. Keep small compressed inputs on tiny
# chunks to preserve the best-effort high-compression guard, but scale up for
# larger inputs to avoid thousands of Python-to-C calls.
_BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE = 16
_BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE = 1024
_BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS = 64


# ---------------------------------------------------------------------------
# Body capture helpers (opt-in per run via captureNetworkBodies registry flag)
# ---------------------------------------------------------------------------


_TEXT_CONTENT_TYPES = (
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
)

# Header names containing any of these keywords (case-insensitive) are redacted.
_SENSITIVE_HEADER_KEYWORDS = (
    "auth",
    "token",
    "secret",
    "api-key",
    "apikey",
    "credential",
    "password",
    "cookie",
)


def _make_streaming_decompressor(
    decomp_fn: Callable[[bytes], bytes],
    error_cls: type[Exception],
    encoding_label: str,
) -> Callable[[bytes], bytes]:
    """Wrap a chunk decompressor with log-once + short-circuit on failure.

    ``zlib`` / ``brotli`` / ``zstd`` streaming decompressors have internal
    state that becomes undefined after a decompression error — subsequent
    ``decomp_fn(chunk)`` calls may keep raising or silently produce garbage
    plaintext.  On first error we log once (at debug, mirroring the
    non-streaming ``decompress_body`` pattern), latch a broken flag, and
    return ``b""`` for every subsequent chunk so downstream parsers don't
    consume corrupt output.
    """
    broken = False

    def wrapper(chunk: bytes) -> bytes:
        nonlocal broken
        if broken:
            return b""
        try:
            return decomp_fn(chunk)
        except error_cls as exc:
            broken = True
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Streaming decompression failed ({encoding_label}): {exc}")
            return b""

    return wrapper


def create_stream_decompressor(headers: http.Headers):
    """Create an incremental decompressor for streaming chunks.

    Returns a callable that decompresses each chunk, maintaining state
    across calls.  Returns None if the response is not compressed.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return None
    if encoding in ("gzip", "deflate"):
        wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
        obj = zlib.decompressobj(wbits)
        return _make_streaming_decompressor(obj.decompress, zlib.error, encoding)
    if encoding == "br":
        dec = brotli.Decompressor()
        return _make_streaming_decompressor(dec.process, brotli.error, "br")
    if encoding == "zstd":
        obj = zstandard.ZstdDecompressor().decompressobj()
        return _make_streaming_decompressor(obj.decompress, zstandard.ZstdError, "zstd")
    return None


def decompress_body(
    data: bytes, headers: http.Headers, max_output: int = STREAM_BUFFER_LIMIT
) -> bytes:
    """Decompress response body based on Content-Encoding header.

    The stream callback receives raw wire bytes.  When the server uses
    gzip/deflate/br/zstd encoding, we must decompress before capturing.
    Uses incremental decompression so truncated compressed data still
    yields whatever decompressed bytes are available.

    Output is capped at *max_output* bytes to guard against decompression
    bombs.  Cap enforcement varies by codec:

    - gzip/deflate: hard cap via ``decompressobj.decompress(data, max_length=)``;
      zlib stops decoding once the cap is reached.
    - zstd: hard cap via ``ZstdDecompressor.stream_reader(data).read(max_output)``;
      zstd reads incrementally so total memory is bounded by
      ``max_output`` plus library internal buffers.
    - br: bounded accumulator over small compressed input chunks.  The
      Python ``brotli`` bindings expose no max-output API, so ``process`` may
      still transiently emit a multi-MB chunk, but decoding stops once
      ``max_output`` bytes have been accumulated instead of materialising the
      full response before slicing.

    Returns the original data unchanged when the encoding is missing,
    ``identity``, or unrecognised, and on decompression error.  A valid
    frame that decodes to an empty body returns ``b""`` — callers that
    short-circuit via ``if not body`` rely on that (see #10287).
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return data
    try:
        if encoding in ("gzip", "deflate"):
            # wbits: gzip=16+MAX_WBITS, deflate=MAX_WBITS
            wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
            obj = zlib.decompressobj(wbits)
            return obj.decompress(data, max_length=max_output)
        if encoding == "br":
            return _decompress_brotli_bounded(data, max_output)
        if encoding == "zstd":
            # stream_reader.read(n) reads *up to* n bytes: the full frame if
            # smaller than n, exactly n if larger — so total memory is bounded
            # by n plus ZSTD_DStream{In,Out}Size (~128 KB library buffers).
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                return reader.read(max_output)
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        with contextlib.suppress(AttributeError):
            # ctx.log unavailable outside mitmproxy runtime
            ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
    return data


def _decompress_brotli_bounded_with_finished(data: bytes, max_output: int) -> tuple[bytes, bool]:
    if max_output <= 0:
        return b"", False

    chunk_size = min(
        _BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE,
        max(
            _BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE,
            (len(data) + _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS - 1)
            // _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS,
        ),
    )

    dec = brotli.Decompressor()
    out = bytearray()
    for offset in range(0, len(data), chunk_size):
        chunk = data[offset : offset + chunk_size]
        decoded = dec.process(chunk)
        if not decoded:
            continue

        remaining = max_output - len(out)
        if len(decoded) >= remaining:
            out.extend(decoded[:remaining])
            return bytes(out), dec.is_finished()
        out.extend(decoded)

    return bytes(out), dec.is_finished()


def _decompress_brotli_bounded(data: bytes, max_output: int) -> bytes:
    body, _finished = _decompress_brotli_bounded_with_finished(data, max_output)
    return body


def _decompress_zlib_json_usage_body(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> tuple[bytes, str | None]:
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    remaining_data = data
    out = bytearray()

    while remaining_data:
        if len(out) >= max_output:
            return bytes(out), None

        obj = zlib.decompressobj(wbits)
        try:
            decoded = obj.decompress(remaining_data, max_length=max_output - len(out))
        except zlib.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"

        out.extend(decoded)
        if not obj.eof:
            if data and not out:
                return bytes(out), "incomplete compressed body"
            return bytes(out), None
        if not obj.unused_data:
            return bytes(out), None
        remaining_data = obj.unused_data

    return bytes(out), None


def decompress_json_usage_body(
    data: bytes, headers: http.Headers, max_output: int = LARGE_RESPONSE_DECOMPRESS_LIMIT
) -> tuple[bytes, str | None]:
    """Decompress a JSON usage response body with an observable empty-prefix error.

    ``decompress_body`` intentionally treats truncated compressed prefixes as an
    empty body because body capture can still mark those responses truncated
    from stream metadata. JSON usage fallback only has the final buffer, so it
    needs to distinguish a valid compressed empty response from an incomplete
    compressed frame that produced no JSON bytes.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if encoding in ("gzip", "deflate"):
        return _decompress_zlib_json_usage_body(data, encoding, max_output)
    if encoding == "br":
        try:
            body, finished = _decompress_brotli_bounded_with_finished(data, max_output)
        except brotli.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"
        if data and not body and not finished:
            return body, "incomplete compressed body"
        return body, None
    if encoding == "zstd":
        try:
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                body = reader.read(max_output)
        except zstandard.ZstdError as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"
        if data and not body:
            try:
                obj = zstandard.ZstdDecompressor().decompressobj()
                obj.decompress(data)
            except zstandard.ZstdError:
                return body, "incomplete compressed body"
            if not obj.eof:
                return body, "incomplete compressed body"
        return body, None
    if encoding and encoding != "identity" and data:
        return b"", "unsupported content encoding"
    return decompress_body(data, headers, max_output=max_output), None


def _is_text_content(content_type: str) -> bool:
    """Check if content-type indicates text-like content worth capturing."""
    if not content_type:
        return True  # assume text when unspecified
    ct = content_type.lower().split(";")[0].strip()
    return any(ct.startswith(prefix) for prefix in _TEXT_CONTENT_TYPES)


def _truncate_bytes_utf8_safe(data: bytes, max_size: int) -> bytes:
    """Truncate bytes at a UTF-8 character boundary.

    After slicing at *max_size*, checks whether the last character is
    complete.  If not, removes the incomplete trailing bytes (at most 4).
    """
    if len(data) <= max_size:
        return data
    t = data[:max_size]
    # Find the start of the last character by scanning backwards
    # past continuation bytes (10xxxxxx = 0x80..0xBF).
    i = len(t)
    while i > 0 and (t[i - 1] & 0xC0) == _UTF8_CONT_MARK:
        i -= 1
    if i == 0:
        return t  # all continuation bytes — shouldn't happen in valid UTF-8
    lead = t[i - 1]
    # Determine the expected sequence length from the lead byte.
    if lead < _UTF8_LEAD_MAX_1BYTE:
        expected = 1
    elif lead < _UTF8_LEAD_MAX_2BYTE:
        expected = 2
    elif lead < _UTF8_LEAD_MAX_3BYTE:
        expected = 3
    else:
        expected = 4
    # If the sequence starting at (i-1) has fewer bytes than expected,
    # it was cut — remove the incomplete sequence.
    actual = len(t) - (i - 1)
    if actual < expected:
        return t[: i - 1]
    return t


def _encode_body(content: bytes, content_type: str) -> tuple:
    """Encode body content. Returns (encoded_string, encoding_type) or (None, None) for binary."""
    if not _is_text_content(content_type):
        return None, None  # skip binary bodies
    try:
        return content.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return base64.b64encode(content).decode("ascii"), "base64"


def _is_sensitive_header(name: str) -> bool:
    """Check if a header name likely carries sensitive data."""
    lower = name.lower()
    return any(kw in lower for kw in _SENSITIVE_HEADER_KEYWORDS)


def _redact_headers(headers) -> dict:
    """Build a dict of headers with sensitive values replaced by ***."""
    result = {}
    for name, value in headers.items(multi=True):
        if name in result:
            continue  # keep first occurrence only (headers.items gives all)
        result[name] = "***" if _is_sensitive_header(name) else value
    return result


def _set_body_fields(
    log_entry: dict,
    side: Literal["request", "response"],
    body: bytes,
    content_type: str,
    *,
    already_truncated: bool = False,
) -> None:
    truncated = already_truncated or len(body) > STREAM_BUFFER_LIMIT
    if truncated:
        # Truncation describes capture completeness, even when no body string is emitted.
        log_entry[f"{side}_body_truncated"] = True

    if not body:
        return

    encoded, encoding = _encode_body(
        _truncate_bytes_utf8_safe(body, STREAM_BUFFER_LIMIT) if truncated else body,
        content_type,
    )
    if encoded is None:
        log_entry[f"{side}_body_encoding"] = "binary"
        return

    log_entry[f"{side}_body"] = encoded
    log_entry[f"{side}_body_encoding"] = encoding


def add_capture_fields(flow: http.HTTPFlow, log_entry: dict) -> None:
    """Add request/response headers and bodies to a log entry.

    # [NETWORK_LOG_FIELDS] — capture-only fields in the shared network log schema.
    # Fields: request_headers, request_body, request_body_encoding,
    #         request_body_truncated, response_headers, response_body,
    #         response_body_encoding, response_body_truncated
    """
    # Request headers (always available)
    log_entry["request_headers"] = _redact_headers(flow.request.headers)

    # Request body
    if flow.request.raw_content:
        req_ct = flow.request.headers.get("content-type", "")
        try:
            body = flow.request.content
        except (zlib.error, ValueError):
            # ZlibError (decompression failure) or ValueError from mitmproxy
            # when Content-Encoding doesn't match the body bytes.
            log_entry["request_body_encoding"] = "binary"
        else:
            if body is not None:
                _set_body_fields(log_entry, "request", body, req_ct)

    # Response headers
    if flow.response:
        log_entry["response_headers"] = _redact_headers(flow.response.headers)

    # Response body — read from stream_buffer (available for all responses).
    # The buffer contains raw wire bytes (possibly gzip/br/zstd compressed).
    if flow.response:
        stream_buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
        stream_state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE)
        stream_truncated = False
        if stream_buf is not None:
            # stream_buffer may already be truncated at STREAM_BUFFER_LIMIT.
            if stream_buf:
                if not stream_state:
                    raise KeyError("truncated")
                stream_truncated = bool(stream_state["truncated"])
            elif stream_state:
                stream_truncated = bool(stream_state.get("truncated", False))
            body = decompress_body(
                bytes(stream_buf),
                flow.response.headers,
                max_output=STREAM_BUFFER_LIMIT + 1,
            )
        else:
            try:
                body = flow.response.content
            except (zlib.error, ValueError):
                # ZlibError (decompression failure) or ValueError from mitmproxy
                log_entry["response_body_encoding"] = "binary"
                return
        if body is None:
            return
        res_ct = flow.response.headers.get("content-type", "")
        # Also check decompressed size in case it expanded beyond the limit.
        _set_body_fields(
            log_entry,
            "response",
            body,
            res_ct,
            already_truncated=stream_truncated,
        )
