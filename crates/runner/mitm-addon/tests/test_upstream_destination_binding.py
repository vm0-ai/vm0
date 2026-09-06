"""Exercise the shared upstream binding resolution contract."""

from mitmproxy import connection, http

import flow_metadata_keys as metadata_keys
import upstream_destination_binding
from tests.upstream_connection_helpers import seed_server_binding

_ALLOWED_KINDS: frozenset[upstream_destination_binding.BindingKind] = frozenset(("connector_auth",))


def _assert_destination_resolution(
    flow: http.HTTPFlow,
    *,
    host: str,
    port: int,
    matches: bool,
    endpoint: tuple[str, int] | None,
) -> None:
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = host
    destination = upstream_destination_binding.normalize_upstream_destination(
        host=host,
        port=port,
    )

    assert (
        upstream_destination_binding.flow_matches_normalized_destination(
            flow,
            destination=destination,
            allowed_kinds=_ALLOWED_KINDS,
        )
        is matches
    )
    assert (
        upstream_destination_binding.bound_destination_endpoint_for_flow(
            flow,
            allowed_kinds=_ALLOWED_KINDS,
        )
        == endpoint
    )


def test_matching_direct_binding_drives_both_projections(real_flow):
    flow = real_flow(with_response=False, host="api.github.com")
    flow.server_conn.address = ("203.0.113.10", 443)
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=_ALLOWED_KINDS,
        original_address=("203.0.113.10", 443),
    )

    _assert_destination_resolution(
        flow,
        host="api.github.com",
        port=443,
        matches=True,
        endpoint=("203.0.113.10", 443),
    )


def test_mismatched_direct_binding_blocks_matching_client_fallback(real_flow):
    flow = real_flow(with_response=False, host="api.github.com")
    flow.server_conn.address = ("203.0.113.10", 443)
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    prior_server = connection.Server(address=("203.0.113.10", 443))
    seed_server_binding(
        prior_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=_ALLOWED_KINDS,
        original_address=("203.0.113.10", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="attacker.example.com",
        port=443,
        kinds=_ALLOWED_KINDS,
        original_address=("203.0.113.10", 443),
    )

    _assert_destination_resolution(
        flow,
        host="api.github.com",
        port=443,
        matches=False,
        endpoint=None,
    )


def test_connected_client_fallback_drives_both_projections_without_direct_binding(real_flow):
    flow = real_flow(with_response=False, host="api.github.com")
    flow.server_conn.address = ("203.0.113.10", 443)
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    prior_server = connection.Server(address=("203.0.113.10", 443))
    seed_server_binding(
        prior_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=_ALLOWED_KINDS,
        original_address=("203.0.113.10", 443),
    )

    _assert_destination_resolution(
        flow,
        host="api.github.com",
        port=443,
        matches=True,
        endpoint=("203.0.113.10", 443),
    )


def test_connected_client_fallback_rejects_stored_port_mismatch(real_flow):
    flow = real_flow(with_response=False, host="api.github.com")
    flow.server_conn.address = ("203.0.113.10", 443)
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    prior_server = connection.Server(address=("203.0.113.10", 443))
    seed_server_binding(
        prior_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=_ALLOWED_KINDS,
        original_address=("203.0.113.10", 8443),
    )

    _assert_destination_resolution(
        flow,
        host="api.github.com",
        port=443,
        matches=False,
        endpoint=None,
    )


def test_unconnected_address_match_has_no_concrete_endpoint(real_flow):
    flow = real_flow(with_response=False, host="api.github.com")

    _assert_destination_resolution(
        flow,
        host="api.github.com",
        port=443,
        matches=True,
        endpoint=None,
    )
