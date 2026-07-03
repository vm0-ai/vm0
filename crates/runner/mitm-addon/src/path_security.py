"""URL path safety helpers."""

import unicodedata
import urllib.parse

from url_syntax import has_unsafe_url_codepoint

_COMPATIBILITY_NORMALIZATION_FORM = "NFKC"
_DOT_SEGMENTS = {".", ".."}
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_MAX_PERCENT_DECODE_PASSES = 5
_PERCENT_ESCAPE_LENGTH = 3


def has_unsafe_path(path: str) -> bool:
    """Return True when a URL path contains or may hide unsafe path syntax."""
    if "\\" in path:
        return True
    return any(_segment_has_unsafe_path(raw_segment) for raw_segment in path.split("/"))


def _segment_has_unsafe_path(raw_segment: str) -> bool:
    segment = raw_segment
    for _ in range(_MAX_PERCENT_DECODE_PASSES):
        if _segment_has_unsafe_syntax(segment):
            return True

        decoded = _percent_decode_segment(segment)
        if decoded is None:
            return True
        if decoded == segment:
            return False
        segment = decoded

    if _segment_has_unsafe_syntax(segment):
        return True
    # A still-changing nested encoding can hide unsafe syntax just past the bound.
    decoded = _percent_decode_segment(segment)
    return decoded is None or decoded != segment


def _segment_has_unsafe_syntax(segment: str) -> bool:
    if _segment_has_unsafe_syntax_parts(segment):
        return True

    normalized = unicodedata.normalize(_COMPATIBILITY_NORMALIZATION_FORM, segment)
    return normalized != segment and (
        "%" in normalized or _segment_has_unsafe_syntax_parts(normalized)
    )


def _segment_has_unsafe_syntax_parts(segment: str) -> bool:
    if has_unsafe_url_codepoint(segment):
        return True
    if "\\" in segment:
        return True
    if _path_part_is_dot_segment(segment):
        return True
    return any(_path_part_is_dot_segment(part) for part in segment.split("/"))


def _path_part_is_dot_segment(part: str) -> bool:
    return part in _DOT_SEGMENTS or part.partition(";")[0] in _DOT_SEGMENTS


def _percent_decode_segment(segment: str) -> str | None:
    index = segment.find("%")
    while index != -1:
        hex_start = index + 1
        hex_end = hex_start + 2
        hex_value = segment[hex_start:hex_end]
        if hex_end > len(segment) or not all(char in _HEX_DIGITS for char in hex_value):
            return None
        index = segment.find("%", index + _PERCENT_ESCAPE_LENGTH)

    try:
        return urllib.parse.unquote_to_bytes(segment).decode("utf-8")
    except UnicodeError:
        return None
