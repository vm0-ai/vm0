"""Shared helpers for upstream mitmproxy test state."""

from typing import cast

from mitmproxy import certs, connection, http

import upstream_destination_binding

# Keep the shape mitmproxy types expect without adding an authoritative endpoint.
_NO_CONNECTED_CLIENT_SOCKNAME = ("", 0)
# Admission only checks that mitmproxy recorded at least one upstream certificate.
_TLS_CERTIFICATE_PROOF = cast(certs.Cert, object())


def bind_flow_upstream(
    flow: http.HTTPFlow,
    *,
    host: str = "api.github.com",
    port: int = 443,
    kinds: frozenset[upstream_destination_binding.BindingKind] = frozenset(("connector_auth",)),
) -> None:
    """Bind a flow to an admitted upstream destination."""
    original_address = flow.server_conn.address
    flow.server_conn.address = (host, port)
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        host=host,
        port=port,
        kinds=kinds,
        original_address=original_address,
    )


def mark_connected_tls_upstream(
    flow: http.HTTPFlow,
    *,
    sni: str,
    server_address: tuple[str, int],
    peername: tuple[str, int] | None,
    client_sockname: tuple[str, int] | None = None,
) -> None:
    """Mark a real flow as connected to an upstream with verified TLS evidence."""
    flow.server_conn.address = server_address
    flow.server_conn.peername = peername
    flow.client_conn.sockname = (
        client_sockname if client_sockname is not None else _NO_CONNECTED_CLIENT_SOCKNAME
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.sni = sni
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (_TLS_CERTIFICATE_PROOF,)
    flow.server_conn.error = None
