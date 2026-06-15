"""Capture-mode header/body sanitization for persistent network logs."""

import base64
import re
import zlib
from email.utils import parsedate_to_datetime
from typing import Literal

from mitmproxy import http

import body_decoding
import flow_metadata_keys as metadata_keys
import response_streaming
from body_limits import STREAM_BUFFER_LIMIT

_REDACTED_HEADER_VALUE = "***"

# UTF-8 byte-boundary markers (RFC 3629). Continuation bytes match
# ``0b10xxxxxx`` via ``(byte & 0xC0) == _UTF8_CONT_MARK``. Lead bytes fall
# into four ranges by ``lead < _UTF8_LEAD_MAX_{N}BYTE`` for N = 1..3.
_UTF8_CONT_MARK = 0x80
_UTF8_LEAD_MAX_1BYTE = 0x80  # ASCII: 0xxxxxxx
_UTF8_LEAD_MAX_2BYTE = 0xE0  # 2-byte lead: 110xxxxx
_UTF8_LEAD_MAX_3BYTE = 0xF0  # 3-byte lead: 1110xxxx

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


def _is_text_content(content_type: str) -> bool:
    """Check if content-type indicates text-like content worth capturing."""
    if not content_type:
        return True  # assume text when unspecified
    ct = content_type.lower().split(";")[0].strip()
    return any(ct.startswith(prefix) for prefix in _TEXT_CONTENT_TYPES)


def _truncate_bytes_utf8_safe(data: bytes, max_size: int) -> bytes:
    """Truncate bytes at a UTF-8 character boundary.

    After slicing at *max_size*, checks whether the last character is complete.
    If not, removes the incomplete trailing bytes (at most 4).
    """
    if len(data) <= max_size:
        return data
    t = data[:max_size]
    # Find the start of the last character by scanning backwards past
    # continuation bytes (10xxxxxx = 0x80..0xBF).
    i = len(t)
    while i > 0 and (t[i - 1] & 0xC0) == _UTF8_CONT_MARK:
        i -= 1
    if i == 0:
        return t  # all continuation bytes; should not happen in valid UTF-8
    lead = t[i - 1]
    if lead < _UTF8_LEAD_MAX_1BYTE:
        expected = 1
    elif lead < _UTF8_LEAD_MAX_2BYTE:
        expected = 2
    elif lead < _UTF8_LEAD_MAX_3BYTE:
        expected = 3
    else:
        expected = 4
    actual = len(t) - (i - 1)
    if actual < expected:
        return t[: i - 1]
    return t


def _encode_body(content: bytes, content_type: str) -> tuple[str | None, str | None]:
    """Encode body content. Returns (encoded_string, encoding_type), or None values."""
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

    Response bodies prefer streaming metadata from
    ``response_streaming.configure_response_stream()`` because that path keeps a
    bounded raw wire-byte buffer and records whether it was truncated. The
    mitmproxy ``flow.response.content`` fallback is used only when no stream
    buffer metadata exists.
    """
    # Request headers (always available)
    log_entry["request_headers"] = _sanitize_headers_for_capture(flow.request.headers)

    # Request body
    if flow.metadata.get(metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE):
        if flow.request.raw_content:
            log_entry["request_body_truncated"] = True
    elif flow.request.raw_content:
        req_ct = flow.request.headers.get("content-type", "")
        request_body = body_decoding.decode_body_bounded(
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

    if flow.response:
        stream_body = response_streaming.captured_response_stream_body(flow)
        stream_truncated = False
        if stream_body is not None:
            stream_truncated = stream_body.truncated
            body = body_decoding.decompress_body(
                bytes(stream_body.buffer),
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
