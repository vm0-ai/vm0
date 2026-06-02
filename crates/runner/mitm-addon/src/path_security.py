"""URL path safety helpers."""

import urllib.parse

_DOT_SEGMENTS = {".", ".."}


def has_unsafe_path(path: str) -> bool:
    """Return True when a URL path contains unsafe separator or dot-segment syntax."""
    if "\\" in path:
        return True
    return any(_segment_has_unsafe_path(raw_segment) for raw_segment in path.split("/"))


def _segment_has_unsafe_path(raw_segment: str) -> bool:
    decoded = urllib.parse.unquote(raw_segment)
    if "\\" in decoded:
        return True
    if decoded in _DOT_SEGMENTS:
        return True
    return any(part in _DOT_SEGMENTS for part in decoded.split("/"))
