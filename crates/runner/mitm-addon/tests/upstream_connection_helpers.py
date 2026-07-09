"""Shared helpers for connected upstream mitmproxy test state."""

from mitmproxy import connection, http


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
    if client_sockname is not None:
        flow.client_conn.sockname = client_sockname
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.sni = sni
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (object(),)
    flow.server_conn.error = None
