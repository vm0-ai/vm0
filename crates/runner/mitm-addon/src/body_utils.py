"""Body processing helpers shared between usage extraction and body capture.

Exports:

- ``STREAM_BUFFER_LIMIT`` — 64 KB cap used by the streaming buffer in
  ``mitm_addon.responseheaders`` and by the decompression safety cap.
- Streaming / one-shot decompression for gzip, deflate, br, zstd.
- UTF-8-safe truncation, text/binary content detection and encoding.
- Header redaction for sensitive names (auth, token, cookie, …).
- ``add_capture_fields`` — composes capture-mode log entry fields.
"""

import base64
import contextlib
import zlib
from collections.abc import Callable

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import ctx, http

# Cap for non-model-provider response body buffering and decompression output.
STREAM_BUFFER_LIMIT = 64 * 1024  # 64 KB

# UTF-8 byte-boundary markers (RFC 3629).  Continuation bytes match
# ``0b10xxxxxx`` → ``(byte & 0xC0) == _UTF8_CONT_MARK``.  Lead bytes fall
# into four ranges by ``lead < _UTF8_LEAD_MAX_{N}BYTE`` for N = 1..3.
_UTF8_CONT_MARK = 0x80
_UTF8_LEAD_MAX_1BYTE = 0x80  # ASCII: 0xxxxxxx
_UTF8_LEAD_MAX_2BYTE = 0xE0  # 2-byte lead: 110xxxxx
_UTF8_LEAD_MAX_3BYTE = 0xF0  # 3-byte lead: 1110xxxx

# Decompression cap for response bodies that need full parsing for usage
# extraction (model-provider non-SSE JSON, billable-connector JSON).  Larger
# than STREAM_BUFFER_LIMIT (which guards capture-mode body logging) so large
# search/timeline payloads decompress fully.  Still bounded so a malicious
# upstream cannot exhaust memory via a decompression bomb.
LARGE_RESPONSE_DECOMPRESS_LIMIT = 5 * 1024 * 1024  # 5 MB


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
    - br: **no hard cap.**  The Python ``brotli`` bindings expose only
      ``Decompressor.process(data)`` which materialises the full decompressed
      output before returning; slicing afterwards does not prevent the
      transient allocation.  Input chunking is not a reliable defence —
      a single brotli copy command can emit up to 16 MB from a handful of
      encoded bytes, so chunk-level bounds don't hold for adversarial
      input.  This is acceptable given the callers only decompress
      bodies from the pre-configured model-provider and billable-connector
      allowlist (not arbitrary user-supplied URLs).

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
            dec = brotli.Decompressor()
            return dec.process(data)[:max_output]
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
            truncated = len(body) > STREAM_BUFFER_LIMIT
            if truncated:
                body = _truncate_bytes_utf8_safe(body, STREAM_BUFFER_LIMIT)
            encoded, encoding = _encode_body(body, req_ct)
            if encoded is not None:
                log_entry["request_body"] = encoded
                log_entry["request_body_encoding"] = encoding
                if truncated:
                    log_entry["request_body_truncated"] = True
            else:
                log_entry["request_body_encoding"] = "binary"

    # Response headers
    if flow.response:
        log_entry["response_headers"] = _redact_headers(flow.response.headers)

    # Response body — read from stream_buffer (available for all responses).
    # The buffer contains raw wire bytes (possibly gzip/br/zstd compressed).
    if flow.response:
        stream_buf = flow.metadata.get("stream_buffer")
        if stream_buf is not None:
            body = decompress_body(bytes(stream_buf), flow.response.headers)
        else:
            try:
                body = flow.response.content
            except (zlib.error, ValueError):
                # ZlibError (decompression failure) or ValueError from mitmproxy
                log_entry["response_body_encoding"] = "binary"
                return
        if not body:
            return
        stream_state = flow.metadata.get("stream_buffer_state")
        res_ct = flow.response.headers.get("content-type", "")
        # stream_buffer may already be truncated at STREAM_BUFFER_LIMIT.
        # Also check decompressed size in case it expanded beyond the limit.
        truncated = (stream_state and stream_state["truncated"]) or len(body) > STREAM_BUFFER_LIMIT
        if truncated:
            body = _truncate_bytes_utf8_safe(body, STREAM_BUFFER_LIMIT)
        encoded, encoding = _encode_body(body, res_ct)
        if encoded is not None:
            log_entry["response_body"] = encoded
            log_entry["response_body_encoding"] = encoding
            if truncated:
                log_entry["response_body_truncated"] = True
        else:
            log_entry["response_body_encoding"] = "binary"
