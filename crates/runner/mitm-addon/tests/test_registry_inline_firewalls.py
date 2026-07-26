"""Tests for inline registry firewalls outside the built-in catalog cache."""

import os

import matching
import registry
from tests.registry_builtin_helpers import (
    cache_firewall,
    first_firewall_core,
    write_catalog_cache,
)
from tests.registry_helpers import inline_vm, write_multi_vm_registry


class TestRegistryInlineFirewalls:
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
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)

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

    def test_inline_only_registry_ignores_catalog_cache_changes(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": inline_vm("run-inline")},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"unused": cache_firewall("unused", "https://unused-a.example.com")},
        )
        os.utime(cache_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            write_catalog_cache(
                cache_path,
                digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version="catalog-b",
                firewalls={"unused": cache_firewall("unused", "https://unused-b.example.com")},
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        _first_vm_info, first_compiled, _first_policies = first_context
        _second_vm_info, second_compiled, _second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is first_firewall_core(second_compiled)

    def test_inline_firewall_api_ids_preserve_custom_ids_and_global_positions(self, tmp_path):
        path = tmp_path / "registry.json"
        vm = inline_vm("run-inline")
        first_api = vm["firewalls"][0]["firewall"]["apis"][0]
        first_api["id"] = "custom-api-id"
        vm["firewalls"].append(
            {
                "kind": "inline",
                "firewall": {
                    "name": "upload",
                    "apis": [{**first_api, "id": "", "base": "https://upload.example.com"}],
                },
            }
        )
        write_multi_vm_registry(path, {"10.200.0.1": vm})

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert [firewall["apis"][0]["id"] for firewall in vm_info["firewalls"]] == [
            "custom-api-id",
            "run-inline:1",
        ]
