"""Tests for built-in registry catalog resolution."""

import os

import pytest

import auth
import builtin_firewall_cache
import builtin_host_policy
import connector_runtime_metadata
import matching
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
        registry_firewalls.ResolvedFirewallEntries([], (), frozenset({"omitted"}))
        registry_firewalls.ResolvedFirewallEntries([inline_firewall], (None,))

        with pytest.raises(ValueError, match="absent when firewalls are absent"):
            registry_firewalls.ResolvedFirewallEntries(None, (None,))
        with pytest.raises(ValueError, match="omitted builtin names must be absent"):
            registry_firewalls.ResolvedFirewallEntries(
                None,
                None,
                frozenset({"omitted"}),
            )
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

    def test_registered_custom_candidate_shadows_only_matching_builtin_api(
        self, tmp_path, mitm_ctx
    ):
        custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
        builtin_name = "multi-api-service"
        custom_name = "custom_connector_550e8400e29b41d4a716446655440000"
        vm = {
            "runId": "run-overlap",
            "connectorRuntimeTargets": [
                {"kind": "builtin", "connectorSlug": builtin_name},
                {"kind": "custom", "customConnectorId": custom_connector_id},
            ],
            "firewalls": [
                {"kind": "builtin", "name": builtin_name},
                {
                    "kind": "inline",
                    "customConnectorId": custom_connector_id,
                    "firewall": {
                        "name": custom_name,
                        "apis": [
                            {
                                "base": "https://api.example.test/",
                                "auth": {"headers": {"Authorization": "Bearer custom"}},
                                "permissions": [
                                    {
                                        "name": "custom-read",
                                        "rules": ["GET /v1/items/{id}"],
                                    }
                                ],
                            }
                        ],
                    },
                },
            ],
            "networkPolicies": {
                builtin_name: {
                    "allow": ["item-read", "audit-read"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                custom_name: {
                    "allow": ["custom-read"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
            },
        }
        catalog_firewall = {
            "name": builtin_name,
            "apis": [
                {
                    "base": "https://api.example.test/v1/",
                    "auth": {"headers": {"Authorization": "Bearer builtin-items"}},
                    "permissions": [{"name": "item-read", "rules": ["GET /items/{id}"]}],
                },
                {
                    "base": "https://audit.example.test/",
                    "auth": {"headers": {"Authorization": "Bearer builtin-audit"}},
                    "permissions": [{"name": "audit-read", "rules": ["GET /events/{id}"]}],
                },
            ],
        }
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": vm},
            {builtin_name: catalog_firewall},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        _, compiled_firewalls, compiled_policies = context
        overlapping = matching.match_compiled_firewall_request(
            "https://api.example.test/v1/items/123",
            "GET",
            compiled_firewalls,
            compiled_policies,
        )
        unrelated = matching.match_compiled_firewall_request(
            "https://audit.example.test/events/456",
            "GET",
            compiled_firewalls,
            compiled_policies,
        )

        assert isinstance(overlapping, matching.FirewallAllow)
        assert overlapping.name == custom_name
        assert overlapping.permission == "custom-read"
        assert isinstance(unrelated, matching.FirewallAllow)
        assert unrelated.name == builtin_name
        assert unrelated.permission == "audit-read"

    def test_registry_owns_connector_candidate_source_metadata(self, tmp_path, mitm_ctx):
        custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
        marker = connector_runtime_metadata.CONNECTOR_RUNTIME_KIND_MARKER
        builtin = github_cache_firewall()
        builtin[marker] = "custom"
        vm = builtin_vm("run-source-metadata", "github")
        vm["connectorRuntimeTargets"] = [
            {"kind": "builtin", "connectorSlug": "github"},
            {"kind": "custom", "customConnectorId": custom_connector_id},
        ]
        vm["firewalls"].extend(
            [
                {
                    "kind": "inline",
                    "customConnectorId": custom_connector_id,
                    "firewall": {
                        marker: "builtin",
                        "name": "custom-service",
                        "apis": [],
                    },
                },
                {
                    "kind": "inline",
                    "firewall": {
                        marker: "custom",
                        "name": "neutral-service",
                        "apis": [],
                    },
                },
            ]
        )
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": vm},
            {"github": builtin},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, _, _ = context
        assert vm_info["firewalls"][0][marker] == "builtin"
        assert vm_info["firewalls"][1][marker] == "custom"
        assert marker not in vm_info["firewalls"][2]

    def test_custom_candidate_route_changes_reconcile_owner_and_billing(self, tmp_path, mitm_ctx):
        custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
        builtin_name = "builtin-service"
        custom_name = "custom-service"
        request_url = "https://api.example.test/v1/items/123"
        catalog_firewall = {
            "name": builtin_name,
            "apis": [
                {
                    "base": "https://api.example.test/v1/",
                    "auth": {"headers": {"Authorization": "Bearer builtin"}},
                    "permissions": [],
                }
            ],
        }
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {},
            {builtin_name: catalog_firewall},
        )
        revision = 0

        def select_owner(custom_base: str | None) -> tuple[str, bool]:
            nonlocal revision
            firewalls: list[dict[str, object]] = [{"kind": "builtin", "name": builtin_name}]
            network_policies: dict[str, dict[str, object]] = {
                builtin_name: {
                    "allow": [],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                }
            }
            vm: dict[str, object] = {
                "runId": "run-dynamic-owner",
                "connectorRuntimeTargets": [
                    {"kind": "builtin", "connectorSlug": builtin_name},
                    {"kind": "custom", "customConnectorId": custom_connector_id},
                ],
                "firewalls": firewalls,
                "networkPolicies": network_policies,
                "billableFirewalls": [builtin_name],
            }
            if custom_base is None:
                vm["omittedCustomConnectorIds"] = [custom_connector_id]
            else:
                firewalls.append(
                    {
                        "kind": "inline",
                        "customConnectorId": custom_connector_id,
                        "firewall": {
                            "name": custom_name,
                            "apis": [
                                {
                                    "base": custom_base,
                                    "auth": {"headers": {"Authorization": "Bearer custom"}},
                                    "permissions": [],
                                }
                            ],
                        },
                    }
                )
                network_policies[custom_name] = {
                    "allow": [],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                }
            write_multi_vm_registry(registry_path, {"10.200.0.1": vm})
            revision += 1
            timestamp = 1_700_000_000_000_000_000 + revision
            os.utime(registry_path, ns=(timestamp, timestamp))

            context = registry.get_vm_context("10.200.0.1", str(registry_path))
            assert context is not None
            vm_info, compiled_firewalls, compiled_policies = context
            result = matching.match_compiled_firewall_request(
                request_url,
                "GET",
                compiled_firewalls,
                compiled_policies,
            )
            assert isinstance(result, matching.FirewallAllow)
            return result.name, auth.is_billable_firewall(result.name, vm_info)

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            assert select_owner("https://api.example.test/") == (custom_name, False)
            assert select_owner("https://api.example.test/v1/items/") == (
                custom_name,
                False,
            )
            assert select_owner("https://api.example.test/unrelated/") == (
                builtin_name,
                True,
            )
            assert select_owner(None) == (builtin_name, True)
            assert select_owner("https://api.example.test/v1/") == (
                custom_name,
                False,
            )

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

    def test_inline_custom_connector_id_is_preserved_on_firewall_and_apis(self):
        custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
        resolved = registry_firewalls.resolve_firewall_entries(
            {
                "runId": "run-custom-id",
                "firewalls": [
                    {
                        "kind": "inline",
                        "customConnectorId": custom_connector_id,
                        "firewall": {
                            "name": "custom_connector_test",
                            "apis": [
                                {
                                    "id": "custom-api:0",
                                    "base": "https://custom.example.test/api/",
                                    "auth": {"headers": {}},
                                }
                            ],
                        },
                    }
                ],
            },
            builtin_firewall_catalog_snapshot=None,
        )

        assert resolved.firewalls is not None
        assert resolved.firewalls[0]["customConnectorId"] == custom_connector_id
        assert resolved.firewalls[0]["apis"][0]["customConnectorId"] == custom_connector_id

    def test_inline_custom_connector_id_rejects_invalid_identity(self):
        with pytest.raises(registry_firewalls.FirewallEntryResolutionError):
            registry_firewalls.resolve_firewall_entries(
                {
                    "runId": "run-custom-id",
                    "firewalls": [
                        {
                            "kind": "inline",
                            "customConnectorId": "not-a-uuid",
                            "firewall": {
                                "name": "custom_connector_test",
                                "apis": [],
                            },
                        }
                    ],
                },
                builtin_firewall_catalog_snapshot=None,
            )
