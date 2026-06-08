"""Sanitizers for values written to persistent network logs."""

import urllib.parse


def _sanitize_netloc_for_network_log(netloc: str) -> str:
    if "@" not in netloc:
        return netloc
    return netloc.rsplit("@", 1)[1]


def _strip_query_fragment_for_network_log(value: str) -> str:
    cut_points = [index for marker in ("?", "#") if (index := value.find(marker)) != -1]
    if not cut_points:
        return value
    return value[: min(cut_points)]


def _sanitize_url_text_fallback_for_network_log(value: str) -> str:
    value = _strip_query_fragment_for_network_log(value)
    scheme, scheme_sep, rest = value.partition("://")
    if scheme_sep:
        netloc, sep, path = rest.partition("/")
        return f"{scheme}{scheme_sep}{_sanitize_netloc_for_network_log(netloc)}{sep}{path}"
    if value.startswith("//"):
        netloc, sep, path = value[2:].partition("/")
        return f"//{_sanitize_netloc_for_network_log(netloc)}{sep}{path}"
    return value


def sanitize_url_for_network_log(value: str) -> str:
    """Return a primary request/proxy URL string for persistent logs.

    Runtime metadata can keep raw URLs because firewall/auth and connector
    billing may need query parameters. Persistent logs do not. This sanitizer
    still preserves path for request diagnostics and is not appropriate for
    arbitrary captured header values.
    """
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return _sanitize_url_text_fallback_for_network_log(value)
    netloc = _sanitize_netloc_for_network_log(parts.netloc)
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))
