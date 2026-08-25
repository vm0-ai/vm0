"""Canonical transport classification for HTTP responses."""

from mitmproxy import http

_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_NO_CONTENT = 204
_HTTP_STATUS_RESET_CONTENT = 205
_HTTP_STATUS_REDIRECT_MIN = 300
_HTTP_STATUS_NOT_MODIFIED = 304
_HTTP_OWS_CHARS = " \t"


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
    """Return whether the normalized response media type is exactly SSE."""
    content_type = response.headers.get("content-type", "")
    media_type = content_type.partition(";")[0].strip(_HTTP_OWS_CHARS).lower()
    return media_type == "text/event-stream"
