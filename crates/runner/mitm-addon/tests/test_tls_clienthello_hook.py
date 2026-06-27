"""Tests for TLS clienthello connection hooks."""

import json
import socket
from unittest.mock import patch

import mitm_addon
import registry
import upstream_destination_binding
from tests.request_handler_helpers import _write_github_firewall_registry


class TestTlsClienthello:
    def test_unregistered_vm_ignored(self, registry_file, make_tls_data, mitm_ctx):
        data = make_tls_data(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is True

    def test_mitm_enabled_returns_early(self, registry_file, make_tls_data, mitm_ctx):
        """When MITM is enabled, tls_clienthello should return without setting ignore_connection."""
        data = make_tls_data(client_ip="10.200.0.1", sni="blocked.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # MITM VM (10.200.0.1) should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_registered_vm_allows_mitm(self, registry_file, make_tls_data, mitm_ctx):
        """Registered VM does NOT set ignore_connection (allows MITM interception)."""
        data = make_tls_data(client_ip="10.200.0.2", sni="anything.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # All registered VMs use MITM — should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_registered_vm_retargets_api_host_from_clienthello_sni(
        self, registry_file, make_tls_data, mitm_ctx
    ):
        data = make_tls_data(
            client_ip="10.200.0.1",
            sni="pr-test-api.vm6.ai",
            client_sni="",
        )

        with (
            mitm_ctx(
                registry_path=str(registry_file),
                api_url="https://pr-test-api.vm6.ai",
            ),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False
        assert data.context.server.address == ("pr-test-api.vm6.ai", 443)
        binding = upstream_destination_binding.binding_snapshot_for_tests()[data.context.server.id]
        assert binding.host == "pr-test-api.vm6.ai"
        assert binding.port == 443
        assert binding.kinds == frozenset(("api_allow",))
        assert binding.original_address == ("203.0.113.10", 443)

    def test_registered_vm_binds_connected_api_edge_when_peer_misses_dns(
        self, registry_file, make_tls_data, mitm_ctx
    ):
        data = make_tls_data(
            client_ip="10.200.0.1",
            sni="pr-test-api.vm6.ai",
            client_sni="",
            server_address=("76.76.21.164", 443),
            server_peername=("76.76.21.164", 443),
            server_connected=True,
        )

        with (
            mitm_ctx(
                registry_path=str(registry_file),
                api_url="https://pr-test-api.vm6.ai",
            ),
            patch.object(
                mitm_addon.socket,
                "getaddrinfo",
                return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("66.33.60.34", 443))],
            ),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False
        assert data.context.server.address == ("76.76.21.164", 443)
        binding = upstream_destination_binding.binding_snapshot_for_tests()[data.context.server.id]
        assert binding.host == "pr-test-api.vm6.ai"
        assert binding.port == 443
        assert binding.kinds == frozenset(("api_allow",))
        assert binding.original_address == ("76.76.21.164", 443)

    def test_registered_vm_retargets_connector_host_from_clienthello_sni(
        self, tmp_path, make_tls_data, mitm_ctx
    ):
        registry_file = _write_github_firewall_registry(tmp_path)
        data = make_tls_data(
            client_ip="10.200.0.5",
            sni="api.github.com",
            client_sni="",
        )

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False
        assert data.context.server.address == ("api.github.com", 443)
        binding = upstream_destination_binding.binding_snapshot_for_tests()[data.context.server.id]
        assert binding.host == "api.github.com"
        assert binding.port == 443
        assert binding.kinds == frozenset(("connector_auth",))
        assert binding.original_address == ("203.0.113.10", 443)

    def test_registered_vm_binds_connected_connector_when_peer_matches_dns(
        self, tmp_path, make_tls_data, mitm_ctx
    ):
        registry_file = _write_github_firewall_registry(tmp_path)
        data = make_tls_data(
            client_ip="10.200.0.5",
            sni="api.github.com",
            server_address=("140.82.112.5", 443),
            server_peername=("140.82.112.5", 443),
            server_connected=True,
        )

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
            patch.object(
                mitm_addon.socket,
                "getaddrinfo",
                return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("140.82.112.5", 443))],
            ),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.context.server.address == ("140.82.112.5", 443)
        binding = upstream_destination_binding.binding_snapshot_for_tests()[data.context.server.id]
        assert binding.host == "api.github.com"
        assert binding.kinds == frozenset(("connector_auth",))
        assert binding.original_address == ("140.82.112.5", 443)

    def test_registered_vm_binds_connected_connector_when_peer_misses_dns(
        self, tmp_path, make_tls_data, mitm_ctx
    ):
        registry_file = _write_github_firewall_registry(tmp_path)
        data = make_tls_data(
            client_ip="10.200.0.5",
            sni="api.github.com",
            server_address=("140.82.112.5", 443),
            server_peername=("140.82.112.5", 443),
            server_connected=True,
        )

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
            patch.object(
                mitm_addon.socket,
                "getaddrinfo",
                side_effect=AssertionError("connector binding must not use fresh DNS"),
            ),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.context.server.address == ("140.82.112.5", 443)
        binding = upstream_destination_binding.binding_snapshot_for_tests()[data.context.server.id]
        assert binding.host == "api.github.com"
        assert binding.kinds == frozenset(("connector_auth",))
        assert binding.original_address == ("140.82.112.5", 443)

    def test_client_disconnect_clears_clienthello_binding(
        self, registry_file, make_tls_data, mitm_ctx
    ):
        data = make_tls_data(
            client_ip="10.200.0.1",
            sni="pr-test-api.vm6.ai",
            client_sni="",
        )

        with (
            mitm_ctx(
                registry_path=str(registry_file),
                api_url="https://pr-test-api.vm6.ai",
            ),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.context.server.id in upstream_destination_binding.binding_snapshot_for_tests()

        mitm_addon.client_disconnected(data.context.client)

        assert (
            data.context.server.id not in upstream_destination_binding.binding_snapshot_for_tests()
        )

    def test_invalid_registered_vm_allows_mitm(self, tmp_path, make_tls_data, mitm_ctx):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps({"vms": {"10.200.0.9": "broken"}, "updatedAt": 0}))
        data = make_tls_data(client_ip="10.200.0.9", sni="anything.com")

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False

    def test_registry_unavailable_does_not_ignore_connection(
        self, registry_file, make_tls_data, mitm_ctx
    ):
        registry.load_registry(str(registry_file))
        registry_file.unlink()
        data = make_tls_data(client_ip="10.200.0.1", sni="anything.com")

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False
