"""Tests for registry sandbox lookup and public compiled context behavior."""

import json

import matching
import registry
from tests.process_log_helpers import capture_addon_process_events
from tests.registry_helpers import write_firewall_registry


class TestGetSandboxInfo:
    def test_known_ip(self, registry_file):
        info = registry.get_sandbox_info("10.200.0.1", str(registry_file))

        assert info is not None
        assert info["runId"] == "run-abc-123"

    def test_unknown_ip(self, registry_file):
        info = registry.get_sandbox_info("192.168.1.1", str(registry_file))

        assert info is None

    def test_invalid_entry_has_no_usable_sandbox_info(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "good-run",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.2": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with capture_addon_process_events():
            sandbox_info = registry.get_sandbox_info("10.200.0.1", str(path))
            assert sandbox_info is not None
            assert sandbox_info["runId"] == "good-run"
            assert registry.get_sandbox_info("10.200.0.2", str(path)) is None
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.invalid_sandboxes) == {"10.200.0.2"}

    def test_invalid_entry_can_recover_to_valid_context(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(json.dumps({"sandboxes": {"10.200.0.1": {"runId": ""}}, "updatedAt": 0}))

        with capture_addon_process_events():
            invalid_state = registry.load_registry_state(str(path))

        assert not isinstance(invalid_state, registry.RegistryUnavailable)
        assert invalid_state.sandboxes == {}
        assert set(invalid_state.invalid_sandboxes) == {"10.200.0.1"}

        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "run-recovered",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                    },
                    "updatedAt": 1,
                }
            )
        )

        recovered_state = registry.load_registry_state(str(path))

        assert not isinstance(recovered_state, registry.RegistryUnavailable)
        assert recovered_state.sandboxes["10.200.0.1"]["runId"] == "run-recovered"
        assert recovered_state.invalid_sandboxes == {}
        assert registry.get_sandbox_info("10.200.0.1", str(path)) == {
            "runId": "run-recovered",
            "billableFirewalls": [],
            "cliAgentType": "claude-code",
        }


class TestGetSandboxContext:
    def test_returns_raw_info_and_compiled_firewall(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, compiled_network_policies = context
        assert sandbox_info["runId"] == "run-abc-123"
        assert registry.get_sandbox_info("10.200.0.1", str(path)) is sandbox_info
        assert compiled_firewalls is not None
        assert compiled_network_policies is not None

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            compiled_firewalls,
            compiled_network_policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry is sandbox_info["firewalls"][0]["apis"][0]

    def test_inline_firewall_entry_allows_http_base(self, tmp_path):
        path = tmp_path / "registry.json"
        write_firewall_registry(path)
        data = json.loads(path.read_text())
        firewall = data["sandboxes"]["10.200.0.1"]["firewalls"][0]["firewall"]
        firewall["apis"][0]["base"] = "http://api.example.com"
        path.write_text(json.dumps(data))

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == "http://api.example.com"
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
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "good-run",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.2": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with capture_addon_process_events():
            assert registry.get_sandbox_context("10.200.0.1", str(path)) is not None
            assert registry.get_sandbox_context("10.200.0.2", str(path)) is None
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.invalid_sandboxes) == {"10.200.0.2"}
