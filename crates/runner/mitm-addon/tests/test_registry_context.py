"""Tests for registry VM lookup and public compiled context behavior."""

import json
from unittest.mock import MagicMock, patch

import matching
import registry
from tests.registry_helpers import write_firewall_registry


class TestGetVmInfo:
    def test_known_ip(self, registry_file):
        info = registry.get_vm_info("10.200.0.1", str(registry_file))

        assert info is not None
        assert info["runId"] == "run-abc-123"

    def test_unknown_ip(self, registry_file):
        info = registry.get_vm_info("192.168.1.1", str(registry_file))

        assert info is None

    def test_invalid_entry_has_no_usable_vm_info(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "good-run"},
                        "10.200.0.2": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            vm_info = registry.get_vm_info("10.200.0.1", str(path))
            assert vm_info is not None
            assert vm_info["runId"] == "good-run"
            assert registry.get_vm_info("10.200.0.2", str(path)) is None
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.invalid_vms) == {"10.200.0.2"}

    def test_invalid_entry_can_recover_to_valid_context(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(json.dumps({"vms": {"10.200.0.1": {"runId": ""}}, "updatedAt": 0}))

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            invalid_state = registry.load_registry_state(str(path))

        assert not isinstance(invalid_state, registry.RegistryUnavailable)
        assert invalid_state.vms == {}
        assert set(invalid_state.invalid_vms) == {"10.200.0.1"}

        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "run-recovered"},
                    },
                    "updatedAt": 1,
                }
            )
        )

        recovered_state = registry.load_registry_state(str(path))

        assert not isinstance(recovered_state, registry.RegistryUnavailable)
        assert recovered_state.vms["10.200.0.1"]["runId"] == "run-recovered"
        assert recovered_state.invalid_vms == {}
        assert registry.get_vm_info("10.200.0.1", str(path)) == {"runId": "run-recovered"}


class TestGetVmContext:
    def test_returns_raw_info_and_compiled_firewall(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, compiled_network_policies = context
        assert vm_info["runId"] == "run-abc-123"
        assert registry.get_vm_info("10.200.0.1", str(path)) is vm_info
        assert compiled_firewalls is not None
        assert compiled_network_policies is not None

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            compiled_firewalls,
            compiled_network_policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry is vm_info["firewalls"][0]["apis"][0]

    def test_inline_firewall_entry_allows_http_base(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        firewall = data["vms"]["10.200.0.1"]["firewalls"][0]["firewall"]
        firewall["apis"][0]["base"] = "http://api.example.com"
        path.write_text(json.dumps(data))

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "http://api.example.com"
        assert isinstance(
            matching.match_compiled_firewall_request(
                "http://api.example.com/items",
                "GET",
                compiled_firewalls,
                compiled_network_policies,
            ),
            matching.FirewallAllow,
        )

    def test_invalid_entry_has_no_context(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "good-run"},
                        "10.200.0.2": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            assert registry.get_vm_context("10.200.0.1", str(path)) is not None
            assert registry.get_vm_context("10.200.0.2", str(path)) is None
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.invalid_vms) == {"10.200.0.2"}
