"""Tests for built-in registry catalog resolution."""

import pytest

import builtin_firewall_cache
import builtin_host_policy
import registry
import registry_firewalls
from tests.registry_builtin_helpers import (
    cache_firewall,
    github_cache_firewall,
    write_catalog_cache,
    write_registry_with_cache,
)
from tests.registry_helpers import builtin_vm, write_multi_vm_registry


class TestRegistryBuiltinCatalogResolution:
    def test_registry_firewalls_does_not_expose_runtime_bundled_catalog(self):
        assert not hasattr(registry_firewalls, "BUILTIN_FIREWALLS")

    def test_resolved_firewall_entries_enforces_cache_key_alignment(self):
        inline_firewall = {"name": "inline", "apis": []}

        registry_firewalls.ResolvedFirewallEntries(None, None)
        registry_firewalls.ResolvedFirewallEntries([], ())
        registry_firewalls.ResolvedFirewallEntries([inline_firewall], (None,))

        with pytest.raises(ValueError, match="absent when firewalls are absent"):
            registry_firewalls.ResolvedFirewallEntries(None, (None,))
        with pytest.raises(ValueError, match="present when firewalls are present"):
            registry_firewalls.ResolvedFirewallEntries([inline_firewall], None)
        with pytest.raises(ValueError, match="align with resolved firewalls"):
            registry_firewalls.ResolvedFirewallEntries([inline_firewall], ())

    def test_builtin_firewall_entry_resolves_from_catalog_cache(self, tmp_path, mitm_ctx):
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": builtin_vm("run-github", "github")},
            {"github": github_cache_firewall()},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["name"] == "github"
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://api.github.com"
        assert vm_info["firewalls"][0]["apis"][0]["id"] == "run-github:0"

    def test_builtin_firewall_entry_prefers_runner_catalog_cache(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "cache-only": cache_firewall(
                    "cache-only",
                    "https://cache-only.example.com",
                )
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        api = vm_info["firewalls"][0]["apis"][0]
        assert api["base"] == "https://cache-only.example.com"
        assert api["auth"]["awsSigv4"]["accessKeyId"] == "${{ secrets.AWS_ACCESS_KEY_ID }}"
        assert api["hostPolicy"]["exactHosts"] == ["cache-only.example.com"]
        assert isinstance(
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER],
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )

    def test_catalog_api_ids_are_reassigned_per_vm(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        firewall = cache_firewall("cache-only", "https://cache-only.example.com")
        firewall["apis"][0]["id"] = "catalog-owned-id"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"cache-only": firewall},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["id"] == "run-cache-only:0"

    def test_missing_runner_catalog_cache_fails_closed(self, tmp_path):
        cache_path = tmp_path / "missing-builtin-firewall-catalog-cache.json"
        snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
            dependency_file_key=None,
            catalog=None,
            cache_path=str(cache_path),
            unavailable_reason="cache_file_missing",
        )

        with pytest.raises(
            registry_firewalls.FirewallEntryResolutionError,
            match='builtin firewall "fallback" catalog cache unavailable: '
            f"cache_file_missing \\({cache_path}\\)",
        ):
            registry_firewalls.resolve_firewall_entries(
                builtin_vm("run-fallback", "fallback"),
                builtin_firewall_catalog_snapshot=snapshot,
            )
