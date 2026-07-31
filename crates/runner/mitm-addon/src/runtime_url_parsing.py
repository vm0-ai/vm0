"""URL parsing for request-lifetime inputs that must not enter global caches."""

import urllib.parse

_uncached_urlsplit = urllib.parse.urlsplit.__wrapped__


def split_runtime_url(value: str) -> urllib.parse.SplitResult:
    """Split a runtime URL without retaining it in urllib's process-wide LRU."""
    return _uncached_urlsplit(value)
