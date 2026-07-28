"""HTTP network-log target metadata helpers."""

import urllib.parse
from typing import cast

from mitmproxy import http

import flow_metadata_keys as metadata_keys

_HTTP_DEFAULT_PORT = 80
_HTTPS_DEFAULT_PORT = 443


def set_target(flow: http.HTTPFlow, *, url: str, host: str, port: int) -> None:
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": url,
        "host": host,
        "port": port,
    }


def fallback_host_port(flow: http.HTTPFlow, original_url: str) -> tuple[str, int]:
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        parsed_port = parsed_url.port
        port = (
            (_HTTPS_DEFAULT_PORT if parsed_url.scheme == "https" else _HTTP_DEFAULT_PORT)
            if parsed_port is None
            else parsed_port
        )
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port
    return host, port


def set_target_from_url(flow: http.HTTPFlow, url: str) -> None:
    host, port = fallback_host_port(flow, url)
    set_target(flow, url=url, host=host, port=port)


def target(flow: http.HTTPFlow) -> tuple[str, str, int]:
    typed_target = cast(
        dict[str, object],
        flow.metadata[metadata_keys.NETWORK_LOG_TARGET],
    )
    return (
        cast(str, typed_target["url"]),
        cast(str, typed_target["host"]),
        cast(int, typed_target["port"]),
    )
