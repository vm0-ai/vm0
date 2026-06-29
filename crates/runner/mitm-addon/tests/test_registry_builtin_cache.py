"""Tests for registry built-in firewall resolution and core-cache behavior."""

import json
import os
from unittest.mock import MagicMock, patch

import matching
import registry
import registry_firewalls
from tests.registry_helpers import (
    builtin_vm,
    inline_vm,
    write_multi_vm_registry,
)


def _first_firewall_core(compiled_firewalls: matching.CompiledFirewallSet):
    return compiled_firewalls.firewalls[0].core


class TestRegistryBuiltinCache:
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

    def test_repeated_builtin_firewall_refs_share_core_but_keep_vm_api_ids(self, tmp_path):
        path = tmp_path / "registry.json"
        write_multi_vm_registry(
            path,
            {
                "10.200.0.1": builtin_vm("run-github-a", "github"),
                "10.200.0.2": builtin_vm("run-github-b", "github"),
            },
        )

        first_context = registry.get_vm_context("10.200.0.1", str(path))
        second_context = registry.get_vm_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, first_policies = first_context
        second_vm_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is _first_firewall_core(second_compiled)

        first_result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_vm_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_vm_info["firewalls"][0]["apis"][0]
        assert first_result.api_entry["id"] == "run-github-a:0"
        assert second_result.api_entry["id"] == "run-github-b:0"

    def test_builtin_firewall_refs_share_static_payload_but_keep_vm_api_shells(
        self, tmp_path, monkeypatch
    ):
        auth = {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}}
        permissions = [{"name": "read-items", "rules": ["GET /items"]}]
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "large": {
                    "name": "large",
                    "apis": [
                        {
                            "base": "https://api.example.com",
                            "auth": auth,
                            "permissions": permissions,
                        },
                        {
                            "base": "https://upload.example.com",
                            "auth": auth,
                            "permissions": permissions,
                        },
                    ],
                }
            },
        )
        path = tmp_path / "registry.json"
        write_multi_vm_registry(
            path,
            {
                "10.200.0.1": builtin_vm("run-large-a", "large"),
                "10.200.0.2": builtin_vm("run-large-b", "large"),
            },
        )

        first_context = registry.get_vm_context("10.200.0.1", str(path))
        second_context = registry.get_vm_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, first_policies = first_context
        second_vm_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is _first_firewall_core(second_compiled)

        first_firewall = first_vm_info["firewalls"][0]
        second_firewall = second_vm_info["firewalls"][0]
        assert first_firewall is not second_firewall
        assert first_firewall["apis"] is not second_firewall["apis"]

        first_api = first_firewall["apis"][0]
        second_api = second_firewall["apis"][0]
        assert first_api is not second_api
        assert first_api["id"] == "run-large-a:0"
        assert second_api["id"] == "run-large-b:0"
        assert first_api["permissions"] is permissions
        assert second_api["permissions"] is permissions
        assert first_api["auth"] is auth
        assert second_api["auth"] is auth

        first_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_api
        assert second_result.api_entry is second_api

    def test_builtin_refs_with_different_base_url_vars_do_not_share_core(self, tmp_path):
        path = tmp_path / "registry.json"
        write_multi_vm_registry(
            path,
            {
                "10.200.0.1": builtin_vm(
                    "run-zendesk-a",
                    "zendesk",
                    {"ZENDESK_SUBDOMAIN": "acme"},
                ),
                "10.200.0.2": builtin_vm(
                    "run-zendesk-b",
                    "zendesk",
                    {"ZENDESK_SUBDOMAIN": "beta"},
                ),
            },
        )

        first_context = registry.get_vm_context("10.200.0.1", str(path))
        second_context = registry.get_vm_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, first_policies = first_context
        second_vm_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)
        assert first_vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.zendesk.com"
        assert second_vm_info["firewalls"][0]["apis"][0]["base"] == "https://beta.zendesk.com"

        first_result = matching.match_compiled_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://beta.zendesk.com/api/v2/tickets",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_vm_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_vm_info["firewalls"][0]["apis"][0]

    def test_builtin_compile_cache_is_scoped_to_registry_path(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        data = {"10.200.0.1": builtin_vm("run-github", "github")}
        write_multi_vm_registry(path_a, data)
        write_multi_vm_registry(path_b, data)

        first_context = registry.get_vm_context("10.200.0.1", str(path_a))
        second_context = registry.get_vm_context("10.200.0.1", str(path_b))

        assert first_context is not None
        assert second_context is not None
        _, first_compiled, _ = first_context
        _, second_compiled, _ = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)

    def test_invalid_builtin_entry_does_not_poison_valid_vm_core_cache(self, tmp_path):
        path = tmp_path / "registry.json"
        write_multi_vm_registry(
            path,
            {
                "10.200.0.1": builtin_vm("run-github", "github"),
                "10.200.0.2": builtin_vm("run-missing", "missing-firewall"),
            },
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            valid_context = registry.get_vm_context("10.200.0.1", str(path))
            invalid_context = registry.get_vm_context("10.200.0.2", str(path))
            state = registry.load_registry_state(str(path))

        assert valid_context is not None
        assert invalid_context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.2"].reason == "invalid_firewalls"
        _, compiled_firewalls, compiled_policies = valid_context
        assert compiled_firewalls is not None
        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            compiled_firewalls,
            compiled_policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_builtin_core_cache_prunes_inactive_keys_on_registry_reload(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "cache-a": {
                    "name": "cache-a",
                    "apis": [
                        {
                            "base": "https://api-a.example.com",
                            "auth": {"headers": {"Authorization": "Bearer token"}},
                            "permissions": [],
                        }
                    ],
                },
                "cache-b": {
                    "name": "cache-b",
                    "apis": [
                        {
                            "base": "https://api-b.example.com",
                            "auth": {"headers": {"Authorization": "Bearer token"}},
                            "permissions": [],
                        }
                    ],
                },
            },
        )
        path = tmp_path / "registry.json"
        write_multi_vm_registry(path, {"10.200.0.1": builtin_vm("run-cache-a", "cache-a")})
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        first_context = registry.get_vm_context("10.200.0.1", str(path))

        assert first_context is not None
        assert len(registry._registry_state.builtin_firewall_core_cache) == 1
        first_cache_key = next(iter(registry._registry_state.builtin_firewall_core_cache))
        assert first_cache_key[0] == "cache-a"

        write_multi_vm_registry(path, {"10.200.0.1": builtin_vm("run-cache-b", "cache-b")})
        os.utime(path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
        second_context = registry.get_vm_context("10.200.0.1", str(path))

        assert second_context is not None
        assert len(registry._registry_state.builtin_firewall_core_cache) == 1
        second_cache_key = next(iter(registry._registry_state.builtin_firewall_core_cache))
        assert second_cache_key[0] == "cache-b"

    def test_inline_firewalls_do_not_share_compiled_core(self, tmp_path):
        path = tmp_path / "registry.json"
        write_multi_vm_registry(
            path,
            {
                "10.200.0.1": inline_vm("run-inline-a"),
                "10.200.0.2": inline_vm("run-inline-b"),
            },
        )

        first_context = registry.get_vm_context("10.200.0.1", str(path))
        second_context = registry.get_vm_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, first_policies = first_context
        second_vm_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)

        first_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_vm_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_vm_info["firewalls"][0]["apis"][0]
