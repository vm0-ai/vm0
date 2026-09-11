"""Canonical transport classification for HTTP responses."""

from mitmproxy import http

_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_NO_CONTENT = 204
_HTTP_STATUS_RESET_CONTENT = 205
_HTTP_STATUS_REDIRECT_MIN = 300
_HTTP_STATUS_NOT_MODIFIED = 304
_HTTP_OWS_BYTES = b" \t"
_CONTENT_TYPE_NAME = b"content-type"
_MAX_CONTENT_TYPE_FIELDS = 8 * 1024
_MAX_CONTENT_TYPE_PREFIX_BYTES = 8 * 1024


def can_have_body(flow: http.HTTPFlow, response: http.Response) -> bool:
    """Return whether HTTP semantics permit content on this response."""
    status_code = response.status_code
    if status_code < _HTTP_STATUS_SUCCESS_MIN or status_code in (
        _HTTP_STATUS_NO_CONTENT,
        _HTTP_STATUS_RESET_CONTENT,
        _HTTP_STATUS_NOT_MODIFIED,
    ):
        return False
    method = flow.request.method.upper()
    if method == "HEAD":
        return False
    return method != "CONNECT" or status_code >= _HTTP_STATUS_REDIRECT_MIN


def has_event_stream_media_type(response: http.Response) -> bool:
    """Recognize exactly SSE within bounded raw field and media-type prefixes.

    Missing, repeated, or over-budget fields do not establish SSE. Parameters
    after an in-budget semicolon are irrelevant and are never copied or decoded.
    """
    fields = response.headers.fields
    if len(fields) > _MAX_CONTENT_TYPE_FIELDS:
        return False

    content_type: bytes | None = None
    for name, value in fields:
        if len(name) != len(_CONTENT_TYPE_NAME) or name.lower() != _CONTENT_TYPE_NAME:
            continue
        if content_type is not None:
            return False
        content_type = value
    if content_type is None:
        return False

    media_type_end = content_type.find(b";", 0, _MAX_CONTENT_TYPE_PREFIX_BYTES)
    if media_type_end < 0:
        if len(content_type) > _MAX_CONTENT_TYPE_PREFIX_BYTES:
            return False
        media_type_end = len(content_type)
    media_type = content_type[:media_type_end].strip(_HTTP_OWS_BYTES).lower()
    return media_type == b"text/event-stream"
