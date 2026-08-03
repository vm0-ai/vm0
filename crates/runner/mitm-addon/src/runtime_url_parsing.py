"""URL operations for request-lifetime inputs."""

import urllib.parse

_uncached_urlsplit = urllib.parse.urlsplit.__wrapped__


def strip_url_query_and_fragment(value: str) -> str:
    """Return the URL prefix before its raw query or fragment delimiter."""
    query_start = value.find("?")
    fragment_start = value.find("#", 0, query_start if query_start >= 0 else len(value))
    if fragment_start >= 0:
        return value[:fragment_start]
    if query_start >= 0:
        return value[:query_start]
    return value


def split_runtime_url(value: str) -> urllib.parse.SplitResult:
    """Split a runtime URL without retaining it in urllib's process-wide LRU."""
    return _uncached_urlsplit(value)
