"""Body processing helpers shared between usage extraction and body capture.

Exports:

- ``STREAM_BUFFER_LIMIT`` — 64 KB cap used by the responseheaders streaming
  buffer and by the decompression safety cap.
- Bounded streaming usage decoding for gzip, deflate, zstd; one-shot
  decompression for gzip, deflate, br, zstd.
- Conservative request-body decoding for billing inspection.
- UTF-8-safe truncation, text/binary content detection and encoding.
- Header value allowlisting for capture-mode persistent logs.
- ``add_capture_fields`` — composes capture-mode log entry fields.
"""

import base64
import contextlib
import re
import zlib
from collections.abc import Callable
from email.utils import parsedate_to_datetime
from typing import IO, Literal, NamedTuple

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import ctx, http

import flow_metadata_keys as metadata_keys

# Cap for non-model-provider response body buffering and decompression output.
STREAM_BUFFER_LIMIT = 64 * 1024  # 64 KB
# Maximum decoded chunk size fed to incremental usage parsers. This bounds
# transient decompressor output without truncating the total response scanned by
# bounded-state parsers.
STREAM_DECODE_CHUNK_LIMIT = 64 * 1024  # 64 KB
_REDACTED_HEADER_VALUE = "***"

# UTF-8 byte-boundary markers (RFC 3629).  Continuation bytes match
# ``0b10xxxxxx`` → ``(byte & 0xC0) == _UTF8_CONT_MARK``.  Lead bytes fall
# into four ranges by ``lead < _UTF8_LEAD_MAX_{N}BYTE`` for N = 1..3.
_UTF8_CONT_MARK = 0x80
_UTF8_LEAD_MAX_1BYTE = 0x80  # ASCII: 0xxxxxxx
_UTF8_LEAD_MAX_2BYTE = 0xE0  # 2-byte lead: 110xxxxx
_UTF8_LEAD_MAX_3BYTE = 0xF0  # 3-byte lead: 1110xxxx

# Decompression cap for production model-provider and connector JSON usage
# fallback paths. Keep this larger than STREAM_BUFFER_LIMIT so diagnostic
# and silent usage fallbacks can parse complete usage payloads while still
# bounding decompression bombs.
LARGE_RESPONSE_DECOMPRESS_LIMIT = 5 * 1024 * 1024  # 5 MB

# Python's brotli binding has no max-output API, and one process() call can
# still transiently emit multi-MB output. Keep small compressed inputs on tiny
# chunks to preserve the best-effort high-compression guard, but scale up for
# larger inputs to avoid thousands of Python-to-C calls.
_BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE = 16
_BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE = 1024
_BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS = 64


class _BoundedDecodeResult(NamedTuple):
    body: bytes
    failed: bool
    error: Exception | None = None


_StreamDecodeFeed = Callable[[bytes], None]


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

_HTTP_FIELD_NAME_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_HTTP_KNOWN_CONTENT_CODING_PATTERN = r"(?:br|compress|deflate|gzip|identity|zstd)"
_HTTP_OPTIONAL_WHITESPACE_PATTERN = r"[ \t]*"
_HTTP_ENCODING_PATTERN = (
    rf"(?:{_HTTP_KNOWN_CONTENT_CODING_PATTERN}|\*)"
    rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN};"
    rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}q="
    r"(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?))?"
)
_HTTP_IMF_FIXDATE_PATTERN = re.compile(
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), "
    r"(?:0[1-9]|[12][0-9]|3[01]) "
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
    r"[0-9]{4} "
    r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT"
)
_UNSAFE_CAPTURE_HEADER_VALUE_CHARS = re.compile(r"[\x00-\x08\x0A-\x1F\x7F]")
_HTTP_OPTIONAL_WHITESPACE = " \t"
_MAX_CAPTURE_HEADER_NAME_LENGTH = 256
_MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE = 256
_REDACTED_HEADER_NAME = "[redacted-header-name]"
_VALUE_PRESERVING_CAPTURE_CONTENT_TYPES = frozenset(
    {
        "application/graphql",
        "application/javascript",
        "application/json",
        "application/octet-stream",
        "application/pdf",
        "application/x-ndjson",
        "application/x-www-form-urlencoded",
        "application/xml",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "multipart/form-data",
        "text/csv",
        "text/event-stream",
        "text/html",
        "text/plain",
        "text/xml",
    }
)
_MAX_CAPTURE_CONTENT_TYPE_MEDIA_TYPE_LENGTH = max(
    len(media_type) for media_type in _VALUE_PRESERVING_CAPTURE_CONTENT_TYPES
)

# Captured header values are untrusted persistent-log data by default. Preserve
# only low-risk protocol metadata that matches conservative HTTP value shapes.
_VALUE_PRESERVING_CAPTURE_HEADER_PATTERNS: dict[str, re.Pattern[str]] = {
    "accept-encoding": re.compile(
        rf"{_HTTP_ENCODING_PATTERN}"
        rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN},"
        rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}{_HTTP_ENCODING_PATTERN})*",
        re.IGNORECASE | re.ASCII,
    ),
    "content-encoding": re.compile(
        rf"{_HTTP_KNOWN_CONTENT_CODING_PATTERN}"
        rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN},"
        rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}{_HTTP_KNOWN_CONTENT_CODING_PATTERN})*",
        re.IGNORECASE | re.ASCII,
    ),
    "content-length": re.compile(r"(?:0|[1-9][0-9]{0,18})"),
}


def _log_streaming_decode_error(encoding_label: str, exc: Exception) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression failed ({encoding_label}): {exc}")


def _log_streaming_decode_skipped(encoding_label: str, reason: str) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression skipped ({encoding_label}): {reason}")


def _make_streaming_decode_guard(
    decode_fn: _StreamDecodeFeed,
    error_cls: type[Exception] | tuple[type[Exception], ...],
    encoding_label: str,
) -> _StreamDecodeFeed:
    """Wrap a streaming decoder with log-once + short-circuit on failure.

    ``zlib`` / ``zstd`` streaming decompressors have internal state that becomes
    undefined after a decompression error — subsequent ``decode_fn(chunk)``
    calls may keep raising or silently produce garbage plaintext. On first
    error we log once (at debug, mirroring the
    non-streaming ``decompress_body`` pattern), latch a broken flag, and
    ignore every subsequent chunk so downstream parsers don't
    consume corrupt output.
    """
    broken = False

    def wrapper(chunk: bytes) -> None:
        nonlocal broken
        if broken:
            return
        try:
            decode_fn(chunk)
        except error_cls as exc:
            broken = True
            _log_streaming_decode_error(encoding_label, exc)

    return wrapper


def _feed_chunks(feed: _StreamDecodeFeed, data: bytes, max_decoded_chunk: int) -> None:
    for offset in range(0, len(data), max_decoded_chunk):
        feed(data[offset : offset + max_decoded_chunk])


def _create_zlib_stream_decode_feed(
    feed: _StreamDecodeFeed,
    *,
    encoding: Literal["gzip", "deflate"],
    max_decoded_chunk: int,
) -> _StreamDecodeFeed:
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    obj = zlib.decompressobj(wbits)

    def decode(chunk: bytes) -> None:
        nonlocal obj
        data = chunk
        while data:
            decoded = obj.decompress(data, max_length=max_decoded_chunk)
            if decoded:
                feed(decoded)
            if obj.unconsumed_tail:
                data = obj.unconsumed_tail
                continue
            if obj.eof:
                data = obj.unused_data
                obj = zlib.decompressobj(wbits)
                if data:
                    continue
            return

    return _make_streaming_decode_guard(decode, zlib.error, encoding)


class _ChunkedDecodeSink(IO[bytes]):
    def __init__(self, feed: _StreamDecodeFeed, max_decoded_chunk: int) -> None:
        self._feed = feed
        self._max_decoded_chunk = max_decoded_chunk

    def write(self, data: bytes) -> int:
        _feed_chunks(self._feed, data, self._max_decoded_chunk)
        return len(data)

    def writable(self) -> bool:
        return True

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


def _create_zstd_stream_decode_feed(
    feed: _StreamDecodeFeed, *, max_decoded_chunk: int
) -> _StreamDecodeFeed:
    sink = _ChunkedDecodeSink(feed, max_decoded_chunk)
    writer = zstandard.ZstdDecompressor().stream_writer(sink)

    def decode(chunk: bytes) -> None:
        writer.write(chunk)

    return _make_streaming_decode_guard(decode, zstandard.ZstdError, "zstd")


def _stream_decode_skip_reason(encoding: str) -> str | None:
    if not encoding or encoding == "identity":
        return None
    if encoding in ("gzip", "deflate", "zstd"):
        return None
    if encoding == "br":
        return "brotli streaming output cannot be bounded"
    return "unsupported content encoding"


def can_stream_decode_usage(headers: http.Headers) -> bool:
    """Return whether usage parsers can safely consume this response stream."""
    encoding = headers.get("content-encoding", "").strip().lower()
    reason = _stream_decode_skip_reason(encoding)
    if reason is None:
        return True
    _log_streaming_decode_skipped(encoding, reason)
    return False


def create_stream_decode_feed(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
) -> _StreamDecodeFeed | None:
    """Create a bounded streaming decoder that feeds decoded usage-parser chunks.

    Usage parsers are bounded-state scanners and may need to inspect long
    responses, so this helper does not enforce a total decoded-byte cap. It
    bounds each decoded chunk before parser entry to prevent high-ratio
    compressed input from materialising one large ``bytes`` object. Returns
    None when a content encoding cannot be safely decoded incrementally.
    """
    if max_decoded_chunk <= 0:
        raise ValueError("max_decoded_chunk must be positive")
    encoding = headers.get("content-encoding", "").strip().lower()
    if not can_stream_decode_usage(headers):
        return None
    if not encoding or encoding == "identity":
        return feed
    if encoding in ("gzip", "deflate"):
        return _create_zlib_stream_decode_feed(
            feed,
            encoding=encoding,
            max_decoded_chunk=max_decoded_chunk,
        )
    if encoding == "zstd":
        return _create_zstd_stream_decode_feed(feed, max_decoded_chunk=max_decoded_chunk)
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
      zlib stops decoding once the cap is reached. Concatenated members are
      decoded until the shared cap is exhausted.
    - zstd: hard cap via ``ZstdDecompressor.stream_reader(data).read(max_output)``;
      zstd reads incrementally so total memory is bounded by
      ``max_output`` plus library internal buffers.
    - br: bounded accumulator over small compressed input chunks.  The
      Python ``brotli`` bindings expose no max-output API, so ``process`` may
      still transiently emit a multi-MB chunk, but decoding stops once
      ``max_output`` bytes have been accumulated instead of materialising the
      full response before slicing.

    Returns the original data unchanged when the encoding is missing,
    ``identity``, unrecognised, or invalid before any compressed member
    completes. Once a member has completed, later invalid trailing data is
    ignored on this best-effort path. A valid frame that decodes to an empty
    body returns ``b""`` — callers that short-circuit via ``if not body`` rely
    on that (see #10287).
    """
    result = _decode_body_bounded(data, headers, max_output=max_output)
    if result.failed and result.error is not None:
        with contextlib.suppress(AttributeError):
            # ctx.log unavailable outside mitmproxy runtime
            ctx.log.debug(
                "Decompression failed "
                f"({headers.get('content-encoding', '').strip().lower()}): {result.error}"
            )
    return result.body


def _decompress_zlib_best_effort_bounded(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> _BoundedDecodeResult:
    if max_output <= 0:
        return _BoundedDecodeResult(b"", False)

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    remaining_data = data
    out = bytearray()
    completed_member = False

    while remaining_data and len(out) < max_output:
        obj = zlib.decompressobj(wbits)
        member_data = remaining_data

        while member_data and len(out) < max_output:
            try:
                decoded = obj.decompress(member_data, max_length=max_output - len(out))
            except zlib.error as exc:
                if completed_member:
                    return _BoundedDecodeResult(bytes(out), False)
                return _BoundedDecodeResult(data, True, exc)

            out.extend(decoded)
            if obj.unconsumed_tail:
                member_data = obj.unconsumed_tail
                continue
            break

        if len(out) >= max_output:
            return _BoundedDecodeResult(bytes(out), False)
        if obj.eof:
            completed_member = True
            if obj.unused_data:
                remaining_data = obj.unused_data
                continue
            return _BoundedDecodeResult(bytes(out), False)
        return _BoundedDecodeResult(bytes(out), False)

    return _BoundedDecodeResult(bytes(out), False)


def _decode_body_bounded(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int,
    fail_on_unsupported_encoding: bool = False,
) -> _BoundedDecodeResult:
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return _BoundedDecodeResult(data, False)
    try:
        if encoding in ("gzip", "deflate"):
            return _decompress_zlib_best_effort_bounded(data, encoding, max_output)
        if encoding == "br":
            return _BoundedDecodeResult(_decompress_brotli_bounded(data, max_output), False)
        if encoding == "zstd":
            # stream_reader.read(n) reads *up to* n bytes: the full frame if
            # smaller than n, exactly n if larger — so total memory is bounded
            # by n plus ZSTD_DStream{In,Out}Size (~128 KB library buffers).
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                return _BoundedDecodeResult(reader.read(max_output), False)
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        return _BoundedDecodeResult(data, True, exc)
    if fail_on_unsupported_encoding:
        return _BoundedDecodeResult(b"", True)
    return _BoundedDecodeResult(data, False)


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


def _decode_zlib_request_body_for_billing(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> bytes | None:
    wbits_options = (
        (16 + zlib.MAX_WBITS,) if encoding == "gzip" else (zlib.MAX_WBITS, -zlib.MAX_WBITS)
    )
    for wbits in wbits_options:
        obj = zlib.decompressobj(wbits)
        try:
            decoded = obj.decompress(data, max_length=max_output + 1)
        except zlib.error:
            continue
        if len(decoded) > max_output:
            return None
        if not obj.eof or obj.unused_data:
            continue
        return decoded
    return None


def decode_request_body_for_billing(
    raw_content: bytes | None,
    headers: http.Headers,
    *,
    max_raw: int = STREAM_BUFFER_LIMIT,
    max_decoded: int = STREAM_BUFFER_LIMIT,
) -> bytes | None:
    """Decode a request body for conservative billing inspection.

    Unlike response capture helpers, billing must fail closed: unsupported,
    invalid, incomplete, or oversized encoded bodies are treated as
    uninspectable rather than falling back to raw bytes.
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
            # First use stream_reader().read(max_output) as the bounded-output
            # primary path. For zstd, an incomplete frame can read as empty
            # without proving whether the frame is a valid empty payload, so
            # only the empty-output case needs a second state check below.
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                body = reader.read(max_output)
        except zstandard.ZstdError as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"
        if data and not body:
            try:
                # A fresh decompressobj exposes eof, which distinguishes a
                # complete empty zstd frame from an incomplete prefix. The
                # gzip/deflate and brotli branches already get equivalent
                # completion signals through their codec-specific helpers.
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


def _is_http_date_header_value(value: str) -> bool:
    if _HTTP_IMF_FIXDATE_PATTERN.fullmatch(value) is None:
        return False
    try:
        parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return False
    return True


def _sanitize_content_type_for_capture(value: str) -> str | None:
    media_start: int | None = None
    media_end = 0
    optional_whitespace_length = 0

    for index, char in enumerate(value):
        if char in "\r\n":
            return None
        if char == ";":
            return _preserved_capture_content_type(value, media_start, media_end)
        if media_start is None:
            if char in _HTTP_OPTIONAL_WHITESPACE:
                optional_whitespace_length += 1
                if optional_whitespace_length > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
                    return None
                continue
            media_start = index
            optional_whitespace_length = 0
        if char in _HTTP_OPTIONAL_WHITESPACE:
            optional_whitespace_length += 1
            if optional_whitespace_length > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
                return None
            continue
        optional_whitespace_length = 0
        media_end = index + 1
        if media_end - media_start > _MAX_CAPTURE_CONTENT_TYPE_MEDIA_TYPE_LENGTH:
            return None

    if media_start is None or media_end == media_start:
        return None
    return _preserved_capture_content_type(value, media_start, media_end)


def _preserved_capture_content_type(
    value: str,
    media_start: int | None,
    media_end: int,
) -> str | None:
    if media_start is None or media_end == media_start:
        return None
    media_type = value[media_start:media_end].lower()
    if media_type not in _VALUE_PRESERVING_CAPTURE_CONTENT_TYPES:
        return None
    return media_type


def _sanitize_allowed_capture_header_value(name: str, value: str) -> str | None:
    normalized_name = name.strip().lower()

    if normalized_name == "content-type":
        return _sanitize_content_type_for_capture(value)

    pattern = _VALUE_PRESERVING_CAPTURE_HEADER_PATTERNS.get(normalized_name)
    if normalized_name != "date" and pattern is None:
        return None

    if len(value) > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
        return None
    if _UNSAFE_CAPTURE_HEADER_VALUE_CHARS.search(value) is not None:
        return None
    normalized_value = value.strip(_HTTP_OPTIONAL_WHITESPACE)
    if normalized_name == "date":
        return normalized_value if _is_http_date_header_value(normalized_value) else None

    if pattern is None:
        return None
    if pattern.fullmatch(normalized_value) is None:
        return None
    return normalized_value


def _sanitize_header_value_for_capture(name: str, value: str) -> str:
    return _sanitize_allowed_capture_header_value(name, value) or _REDACTED_HEADER_VALUE


def _sanitize_header_name_for_capture(name: str) -> str:
    if len(name) > _MAX_CAPTURE_HEADER_NAME_LENGTH:
        return _REDACTED_HEADER_NAME
    if _HTTP_FIELD_NAME_PATTERN.fullmatch(name) is None:
        return _REDACTED_HEADER_NAME
    return name


def _sanitize_headers_for_capture(headers) -> dict:
    """Build a dict of captured headers safe for persistent network logs."""
    result = {}
    seen_names: set[str] = set()
    for name, value in headers.items(multi=True):
        captured_name = _sanitize_header_name_for_capture(name)
        case_insensitive_name = captured_name.lower()
        if case_insensitive_name in seen_names:
            continue  # keep first occurrence only (headers.items gives all)
        seen_names.add(case_insensitive_name)
        result[captured_name] = _sanitize_header_value_for_capture(captured_name, value)
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
    """Add capture-mode request/response fields to ``log_entry`` in place.

    # [NETWORK_LOG_FIELDS] — capture-only fields in the shared network log schema.
    # Fields: request_headers, request_body, request_body_encoding,
    #         request_body_truncated, response_headers, response_body,
    #         response_body_encoding, response_body_truncated

    Response bodies prefer the streaming metadata populated by
    ``response_streaming.configure_response_stream()`` because that path keeps a
    bounded raw wire-byte buffer and records whether it was truncated. The
    mitmproxy ``flow.response.content`` fallback is used only when no stream
    buffer metadata exists.

    Non-empty ``stream_buffer`` values must have a matching
    ``stream_buffer_state`` with a ``truncated`` flag. Empty stream buffers do
    not require the flag, but present state must still be a dict. Missing or
    malformed state is an internal metadata invariant violation and raises
    ``RuntimeError`` instead of silently falling back.

    Truncation from the streaming buffer is carried as ``already_truncated`` into
    ``_set_body_fields()``, where it is combined with the decompressed body size.
    A ``None`` body means no response body could be obtained; ``b""`` is a valid
    empty body and normally produces no body fields.
    """
    # Request headers (always available)
    log_entry["request_headers"] = _sanitize_headers_for_capture(flow.request.headers)

    # Request body
    if flow.metadata.get(metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE):
        if flow.request.raw_content:
            log_entry["request_body_truncated"] = True
    elif flow.request.raw_content:
        req_ct = flow.request.headers.get("content-type", "")
        request_body = _decode_body_bounded(
            flow.request.raw_content,
            flow.request.headers,
            max_output=STREAM_BUFFER_LIMIT + 1,
            fail_on_unsupported_encoding=True,
        )
        if request_body.failed:
            log_entry["request_body_encoding"] = "binary"
        else:
            _set_body_fields(log_entry, "request", request_body.body, req_ct)

    # Response headers
    if flow.response:
        log_entry["response_headers"] = _sanitize_headers_for_capture(flow.response.headers)

    # Response body — read from stream_buffer (available for all responses).
    # The buffer contains raw wire bytes (possibly gzip/br/zstd compressed).
    if flow.response:
        stream_buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
        stream_state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE)
        stream_truncated = False
        if stream_buf is not None:
            # stream_buffer may already be truncated at STREAM_BUFFER_LIMIT.
            if stream_buf:
                if not isinstance(stream_state, dict) or "truncated" not in stream_state:
                    state_description = (
                        f"keys={sorted(str(key) for key in stream_state)}"
                        if isinstance(stream_state, dict)
                        else f"type={type(stream_state).__name__}"
                    )
                    raise RuntimeError(
                        "Invalid response body capture metadata: stream_buffer is "
                        f"present and non-empty (len={len(stream_buf)}) but "
                        "stream_buffer_state is missing the truncated flag. "
                        "response_streaming.configure_response_stream() must set "
                        "stream_buffer and stream_buffer_state together "
                        f"(stream_buffer_state {state_description})."
                    )
                stream_truncated = bool(stream_state["truncated"])
            elif stream_state is not None and not isinstance(stream_state, dict):
                raise RuntimeError(
                    "Invalid response body capture metadata: stream_buffer is "
                    "empty but stream_buffer_state is not a dict "
                    f"(stream_buffer_state type={type(stream_state).__name__})."
                )
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
