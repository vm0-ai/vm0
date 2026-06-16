"""Tests for TLS clienthello connection hooks."""

import json

import mitm_addon
import registry


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
