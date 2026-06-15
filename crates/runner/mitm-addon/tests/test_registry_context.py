"""Tests for registry VM lookup and compiled context behavior."""

import json
from unittest.mock import MagicMock, patch

import pytest

import matching
import registry
from tests.registry_helpers import pin_mtime, write_firewall_registry


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

    def test_builtin_firewall_entry_resolves_from_catalog(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-github",
                            "firewalls": [{"kind": "builtin", "name": "github"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["name"] == "github"
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://api.github.com"
        assert vm_info["firewalls"][0]["apis"][0]["id"] == "run-github:0"

    def test_builtin_firewall_entry_resolves_dynamic_base_url_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "firewalls": [
                                {
                                    "kind": "builtin",
                                    "name": "zendesk",
                                    "baseUrlVars": {"ZENDESK_SUBDOMAIN": "acme"},
                                }
                            ],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.zendesk.com"

    def test_builtin_firewall_entry_missing_dynamic_var_rejects_vm(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "firewalls": [{"kind": "builtin", "name": "zendesk"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "ZENDESK_SUBDOMAIN" in state.invalid_vms["10.200.0.1"].message

    def test_builtin_firewall_entry_does_not_read_top_level_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "vars": {"ZENDESK_SUBDOMAIN": "top-level"},
                            "firewalls": [{"kind": "builtin", "name": "zendesk"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "ZENDESK_SUBDOMAIN" in state.invalid_vms["10.200.0.1"].message

    def test_unknown_builtin_firewall_entry_rejects_vm(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-missing",
                            "firewalls": [{"kind": "builtin", "name": "missing-firewall"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert "missing-firewall" in state.invalid_vms["10.200.0.1"].message

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

    def test_compiled_context_updates_after_successful_registry_change(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path, rule="/items")
        first_context = registry.get_vm_context("10.200.0.1", str(path))
        assert first_context is not None
        first_vm_info, first_compiled, first_compiled_policies = first_context
        assert first_compiled is not None

        write_firewall_registry(path, rule="/other-resource")
        second_context = registry.get_vm_context("10.200.0.1", str(path))
        assert second_context is not None
        second_vm_info, second_compiled, second_compiled_policies = second_context

        assert second_vm_info is not first_vm_info
        assert second_compiled is not None
        assert second_compiled is not first_compiled
        assert second_compiled_policies is not first_compiled_policies
        assert isinstance(
            matching.match_compiled_firewall_request(
                "https://api.example.com/items",
                "GET",
                second_compiled,
                second_compiled_policies,
            ),
            matching.FirewallBlock,
        )
        assert isinstance(
            matching.match_compiled_firewall_request(
                "https://api.example.com/other-resource",
                "GET",
                second_compiled,
                second_compiled_policies,
            ),
            matching.FirewallAllow,
        )

    def test_successful_registry_change_without_firewalls_clears_compiled_context(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        first_context = registry.get_vm_context("10.200.0.1", str(path))
        assert first_context is not None
        _, first_compiled, first_compiled_policies = first_context
        assert first_compiled is not None

        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {
                            "runId": "run-abc-123",
                            "networkPolicies": {
                                "example": {
                                    "allow": [],
                                    "deny": [],
                                    "unknownPolicy": "allow",
                                }
                            },
                        }
                    },
                    "updatedAt": 1700000000001,
                }
            )
        )

        second_context = registry.get_vm_context("10.200.0.1", str(path))
        assert second_context is not None
        _, second_compiled, second_compiled_policies = second_context
        assert second_compiled is None
        assert second_compiled_policies is not first_compiled_policies

    def test_compiled_context_is_scoped_to_registry_path(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        write_firewall_registry(path_a, rule="/items")
        write_firewall_registry(path_b, rule="/other")
        pin_mtime(path_a)
        pin_mtime(path_b)
        assert path_a.stat().st_size == path_b.stat().st_size

        first_context = registry.get_vm_context("10.200.0.1", str(path_a))
        second_context = registry.get_vm_context("10.200.0.1", str(path_b))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, _ = first_context
        second_vm_info, second_compiled, second_compiled_policies = second_context
        assert first_vm_info is not second_vm_info
        assert second_compiled is not None
        assert second_compiled is not first_compiled
        assert isinstance(
            matching.match_compiled_firewall_request(
                "https://api.example.com/items",
                "GET",
                second_compiled,
                second_compiled_policies,
            ),
            matching.FirewallBlock,
        )
        assert isinstance(
            matching.match_compiled_firewall_request(
                "https://api.example.com/other",
                "GET",
                second_compiled,
                second_compiled_policies,
            ),
            matching.FirewallAllow,
        )

    def test_parse_failure_returns_no_compiled_context(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        context = registry.get_vm_context("10.200.0.1", str(path))
        assert context is not None
        _, compiled_firewalls, _ = context
        assert compiled_firewalls is not None

        path.write_text("{ broken")
        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            unavailable_context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert unavailable_context is None
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"

    def test_missing_file_returns_no_compiled_context(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        context = registry.get_vm_context("10.200.0.1", str(path))
        assert context is not None
        _, compiled_firewalls, _ = context
        assert compiled_firewalls is not None

        path.unlink()
        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            unavailable_context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert unavailable_context is None
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "stat_failed"

    def test_malformed_network_policy_shape_compiles_without_load_failure(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["networkPolicies"] = {"example": "denied"}
        path.write_text(json.dumps(data))

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        _, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is not None
        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            compiled_firewalls,
            compiled_network_policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_network_policy"

    def test_malformed_firewall_config_compiles_without_load_failure(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        firewall = data["vms"]["10.200.0.1"]["firewalls"][0]["firewall"]
        firewall["apis"][0]["permissions"][0]["rules"] = ["GET /items/{a}literal{b}"]
        path.write_text(json.dumps(data))

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        _, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is not None
        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            compiled_firewalls,
            compiled_network_policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    @pytest.mark.parametrize(
        "firewalls",
        [0, 1, False, True, "", {}, {"name": "example"}, "broken"],
    )
    def test_malformed_top_level_firewalls_shape_rejects_vm(self, tmp_path, firewalls):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["firewalls"] = firewalls
        path.write_text(json.dumps(data))

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert "10.200.0.1" not in state.vms
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"

    @pytest.mark.parametrize(
        "firewalls",
        [
            [0],
            [{"kind": "inline"}],
            [{"kind": "builtin", "name": ""}],
            [{"kind": "builtin", "name": "zendesk", "baseUrlVars": []}],
            [{"kind": "builtin", "name": "zendesk", "baseUrlVars": {"ZENDESK_SUBDOMAIN": 1}}],
            [{"name": "github", "apis": []}],
            [{"kind": "unknown", "name": "github"}],
            [{"kind": "unknown", "name": "github", "apis": []}],
        ],
    )
    def test_malformed_firewall_entries_reject_vm(self, tmp_path, firewalls):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["firewalls"] = firewalls
        path.write_text(json.dumps(data))

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            context = registry.get_vm_context("10.200.0.1", str(path))
            state = registry.load_registry_state(str(path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert "10.200.0.1" not in state.vms
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"

    def test_null_top_level_firewalls_shape_is_no_firewall_context(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["firewalls"] = None
        path.write_text(json.dumps(data))

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        _, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is None
        assert compiled_network_policies is not None
