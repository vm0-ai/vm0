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
    """Return a URL string safe for persistent logs.

    Runtime metadata can keep raw URLs because firewall/auth and connector
    billing may need query parameters. Persistent logs do not.
    """
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return _sanitize_url_text_fallback_for_network_log(value)
    netloc = _sanitize_netloc_for_network_log(parts.netloc)
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def sanitize_link_header_for_network_log(value: str) -> str | None:
    """Sanitize complete URI references in a Link header value.

    This is intentionally narrow: it preserves text outside ``<...>`` URI
    references and fails closed on malformed bracket structure.
    """
    output: list[str] = []
    index = 0
    saw_uri_reference = False
    while index < len(value):
        char = value[index]
        if char == ">":
            return None
        if char != "<":
            output.append(char)
            index += 1
            continue

        close_index = value.find(">", index + 1)
        if close_index == -1:
            return None

        raw_url = value[index + 1 : close_index]
        if "<" in raw_url:
            return None

        saw_uri_reference = True
        output.append(f"<{sanitize_url_for_network_log(raw_url)}>")
        index = close_index + 1

    return "".join(output) if saw_uri_reference or not value else None
