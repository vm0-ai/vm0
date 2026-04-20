"""URL reconstruction and rewriting utilities.

Pure functions with no module-level state or I/O.
"""

import urllib.parse

from mitmproxy import http


def get_original_url(flow: http.HTTPFlow) -> str:
    """Reconstruct the original target URL from the request.

    Uses ``flow.request.scheme`` (populated from the TLS handshake) rather
    than inferring from the destination port, and anchors the authority
    on ``pretty_host`` (Host header if present) combined with the actual
    destination port. ``pretty_url`` is intentionally not used: it takes
    the port from the Host header, so a request to ``host:8443`` with a
    plain ``Host: host`` (no port) would lose the ``:8443`` and break
    firewall rule matching.
    """
    scheme = flow.request.scheme
    host = flow.request.pretty_host
    port = flow.request.port

    if (scheme == "https" and port != 443) or (scheme == "http" and port != 80):
        host_with_port = f"{host}:{port}"
    else:
        host_with_port = host

    path = flow.request.path
    return f"{scheme}://{host_with_port}{path}"


def build_rewrite_url(resolved_base: str, match_info: dict, orig_query: str) -> str:
    """Build the final URL for auth.base URL rewriting.

    Combines the resolved base URL (with credentials in path), the relative
    path from the firewall match, and query strings from both base and
    original request. ``orig_query`` is the raw query string of the
    incoming request (no leading ``?``).
    """
    base_parsed = urllib.parse.urlparse(resolved_base)

    # Append rel_path to the base path portion
    rel_path = match_info.get("rel_path", "/")
    base_path = base_parsed.path.rstrip("/") + rel_path if rel_path != "/" else base_parsed.path

    # Merge query strings: base qs + original request qs
    qs_parts: list[str] = []
    if base_parsed.query:
        qs_parts.append(base_parsed.query)
    if orig_query:
        qs_parts.append(orig_query)
    merged_qs = "&".join(qs_parts)

    return urllib.parse.urlunparse(
        (base_parsed.scheme, base_parsed.netloc, base_path, "", merged_qs, "")
    )
