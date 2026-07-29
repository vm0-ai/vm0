"""Tests for built-in registry snapshot identity and invalidation."""

import os
from unittest.mock import patch

import pytest

import builtin_firewall_cache
import builtin_host_policy
import matching
import registry
import registry_firewalls
from tests.registry_builtin_helpers import (
    cache_firewall,
    first_firewall_core,
    write_catalog_cache,
)
from tests.registry_helpers import builtin_vm, inline_vm, write_multi_vm_registry


def _catalog_snapshot(
    *,
    digest_char: str,
    version: str,
    firewalls: dict[str, dict],
) -> builtin_firewall_cache.BuiltinFirewallCatalogSnapshot:
    key = builtin_firewall_cache.CatalogFileKey(
        absolute_path=f"catalog-cache/{version}.json",
        st_dev=1,
        st_ino=1,
        st_mtime_ns=len(version),
        st_size=len(firewalls),
    )
    digest = f"sha256:{digest_char * 64}"
    return builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
        dependency_file_key=key,
        catalog=builtin_firewall_cache.BuiltinFirewallCatalog(
            identity=builtin_firewall_cache.CatalogIdentity(
                source="cache",
                catalog_digest=digest,
                catalog_version=version,
                file_key=key,
            ),
            firewalls=firewalls,
        ),
        cache_path=key.absolute_path,
    )


class TestRegistryBuiltinSnapshot:
    def test_runner_catalog_cache_missing_firewall_fails_closed(self):
        snapshot = _catalog_snapshot(
            digest_char="a",
            version="catalog-a",
            firewalls={
                "other": cache_firewall(
                    "other",
                    "https://cache.example.com",
                )
            },
        )
        assert snapshot.catalog is not None
        rewritten_key = builtin_firewall_cache.CatalogFileKey(
            absolute_path="catalog-cache/catalog-a.json",
            st_dev=1,
            st_ino=2,
            st_mtime_ns=3,
            st_size=4,
        )
        rewritten_snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
            dependency_file_key=rewritten_key,
            catalog=builtin_firewall_cache.BuiltinFirewallCatalog(
                identity=builtin_firewall_cache.CatalogIdentity(
                    source=snapshot.catalog.identity.source,
                    catalog_digest=snapshot.catalog.identity.catalog_digest,
                    catalog_version=snapshot.catalog.identity.catalog_version,
                    file_key=rewritten_key,
                ),
                firewalls=snapshot.catalog.firewalls,
            ),
            cache_path=rewritten_key.absolute_path,
        )
        expected_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

        for current_snapshot in (snapshot, rewritten_snapshot):
            with pytest.raises(
                registry_firewalls.FirewallEntryResolutionError,
                match='builtin firewall "fallback" missing from catalog cache '
                rf"\(catalog_digest={expected_digest}, catalog_version=catalog-a\)",
            ):
                registry_firewalls.resolve_firewall_entries(
                    builtin_vm("run-fallback", "fallback"),
                    builtin_firewall_catalog_snapshot=current_snapshot,
                )

    def test_catalog_identity_is_checked_only_for_cached_builtin_registry(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "cache-only": cache_firewall(
                    "cache-only",
                    "https://cache.example.com",
                )
            },
        )
        original_catalog_file_key = registry_firewalls.catalog_file_key

        with (
            mitm_ctx(
                registry_path=str(registry_path),
                builtin_firewall_catalog_cache_path=str(cache_path),
            ),
            patch.object(
                registry_firewalls,
                "catalog_file_key",
                wraps=original_catalog_file_key,
            ) as catalog_file_key,
        ):
            missing_state = registry.load_registry_state(str(registry_path))
            assert isinstance(missing_state, registry.RegistryUnavailable)
            assert missing_state.reason == "stat_failed"
            assert catalog_file_key.call_count == 0

            write_multi_vm_registry(
                registry_path,
                {"10.200.0.1": inline_vm("run-inline")},
            )
            os.utime(
                registry_path,
                ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000),
            )
            inline_state = registry.load_registry_state(str(registry_path))
            cached_inline_state = registry.load_registry_state(str(registry_path))

            assert not isinstance(inline_state, registry.RegistryUnavailable)
            assert cached_inline_state is inline_state
            assert inline_state.vms["10.200.0.1"]["runId"] == "run-inline"
            assert catalog_file_key.call_count == 0

            write_multi_vm_registry(
                registry_path,
                {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
            )
            os.utime(
                registry_path,
                ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001),
            )
            builtin_state = registry.load_registry_state(str(registry_path))

            assert not isinstance(builtin_state, registry.RegistryUnavailable)
            assert (
                builtin_state.vms["10.200.0.1"]["firewalls"][0]["apis"][0]["base"]
                == "https://cache.example.com"
            )
            assert catalog_file_key.call_count == 0

            cached_builtin_state = registry.load_registry_state(str(registry_path))

        assert cached_builtin_state is builtin_state
        assert catalog_file_key.call_count == 1

    def test_malformed_registry_cache_is_independent_of_catalog_identity(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        registry_path.write_text("{ broken")
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"unused": cache_firewall("unused", "https://unused-a.example.com")},
        )
        os.utime(
            cache_path,
            ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000),
        )
        original_catalog_file_key = registry_firewalls.catalog_file_key

        with (
            mitm_ctx(
                registry_path=str(registry_path),
                builtin_firewall_catalog_cache_path=str(cache_path),
            ) as log,
            patch.object(
                registry_firewalls,
                "catalog_file_key",
                wraps=original_catalog_file_key,
            ) as catalog_file_key,
            patch.object(registry.json, "loads", wraps=registry.json.loads) as json_loads,
        ):
            first_state = registry.load_registry_state(str(registry_path))
            write_catalog_cache(
                cache_path,
                digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version="catalog-b",
                firewalls={"unused": cache_firewall("unused", "https://unused-b.example.com")},
            )
            os.utime(
                cache_path,
                ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001),
            )
            second_state = registry.load_registry_state(str(registry_path))

        assert isinstance(first_state, registry.RegistryUnavailable)
        assert second_state is first_state
        assert json_loads.call_count == 1
        assert catalog_file_key.call_count == 0
        assert log.warn.call_count == 1

    def test_registry_snapshot_uses_actual_loaded_catalog_file_key(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-racy-cache", "racy-cache")},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "racy-cache": cache_firewall(
                    "racy-cache",
                    "https://cache.example.com",
                )
            },
        )
        original_catalog_file_key = registry_firewalls.catalog_file_key
        calls = 0

        def racy_catalog_file_key(cache_path: str | None):
            nonlocal calls
            calls += 1
            if calls == 1:
                return None
            return original_catalog_file_key(cache_path)

        monkeypatch.setattr(registry_firewalls, "catalog_file_key", racy_catalog_file_key)

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))
            assert context is not None
            vm_info, compiled_firewalls, _ = context
            assert compiled_firewalls is not None
            assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache.example.com"

            cache_path.unlink()

            context = registry.get_vm_context("10.200.0.1", str(registry_path))
            state = registry.load_registry_state(str(registry_path))

        assert context is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert (
            "catalog cache unavailable: cache_file_missing"
            in state.invalid_vms["10.200.0.1"].message
        )

    def test_builtin_registry_reload_when_catalog_cache_appears(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-late-cache", "late-cache")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            write_catalog_cache(
                cache_path,
                digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                version="catalog-a",
                firewalls={
                    "late-cache": cache_firewall(
                        "late-cache",
                        "https://cache.example.com",
                    )
                },
            )
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is None
        assert second_context is not None
        second_vm_info, second_compiled, _ = second_context
        assert second_compiled is not None
        assert second_vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache.example.com"

    def test_unknown_builtin_registry_reload_when_catalog_cache_appears(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            first_state = registry.load_registry_state(str(registry_path))
            write_catalog_cache(
                cache_path,
                digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                version="catalog-a",
                firewalls={
                    "cache-only": cache_firewall(
                        "cache-only",
                        "https://cache.example.com",
                    )
                },
            )
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is None
        assert not isinstance(first_state, registry.RegistryUnavailable)
        assert first_state.invalid_vms["10.200.0.1"].reason == "invalid_firewalls"
        assert second_context is not None
        second_vm_info, second_compiled, _ = second_context
        assert second_compiled is not None
        assert second_vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache.example.com"

    def test_registry_reload_pins_one_catalog_snapshot_for_builtin_entries(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {
                "10.200.0.1": {
                    "runId": "run-pinned-cache",
                    "firewalls": [
                        {"kind": "builtin", "name": "alpha"},
                        {"kind": "builtin", "name": "beta"},
                    ],
                }
            },
        )
        snapshots = [
            _catalog_snapshot(
                digest_char="a",
                version="catalog-a",
                firewalls={
                    "alpha": cache_firewall("alpha", "https://alpha-a.example.com"),
                    "beta": cache_firewall("beta", "https://beta-a.example.com"),
                },
            ),
            _catalog_snapshot(
                digest_char="b",
                version="catalog-b",
                firewalls={
                    "alpha": cache_firewall("alpha", "https://alpha-b.example.com"),
                    "beta": cache_firewall("beta", "https://beta-b.example.com"),
                },
            ),
        ]
        load_calls: list[str | None] = []

        def load_catalog_snapshot(
            cache_path: str | None,
        ) -> builtin_firewall_cache.BuiltinFirewallCatalogSnapshot:
            load_calls.append(cache_path)
            return snapshots[min(len(load_calls) - 1, len(snapshots) - 1)]

        monkeypatch.setattr(
            registry_firewalls,
            "load_catalog_snapshot",
            load_catalog_snapshot,
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        bases = [api["base"] for firewall in vm_info["firewalls"] for api in firewall["apis"]]
        assert bases == ["https://alpha-a.example.com", "https://beta-a.example.com"]
        assert load_calls == [str(cache_path)]

    def test_runner_catalog_cache_change_invalidates_registry_snapshot(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-mutable", "mutable")},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"mutable": cache_firewall("mutable", "https://cache-a.example.com")},
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
                firewalls={"mutable": cache_firewall("mutable", "https://cache-b.example.com")},
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, _ = first_context
        second_vm_info, second_compiled, _ = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        first_api = first_vm_info["firewalls"][0]["apis"][0]
        second_api = second_vm_info["firewalls"][0]["apis"][0]
        assert first_api["base"] == "https://cache-a.example.com"
        assert second_api["base"] == "https://cache-b.example.com"
        first_runtime_policy = first_api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER]
        second_runtime_policy = second_api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER]
        assert isinstance(
            first_runtime_policy,
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )
        assert isinstance(
            second_runtime_policy,
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )
        assert first_runtime_policy is not second_runtime_policy
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)

    def test_runner_catalog_cache_change_recompiles_core_when_metadata_is_unchanged(
        self, tmp_path, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {
                "10.200.0.1": {
                    **builtin_vm("run-mutable", "mutable"),
                    "networkPolicies": {
                        "mutable": {
                            "allow": ["read"],
                            "deny": [],
                            "unknownPolicy": "deny",
                        }
                    },
                }
            },
        )
        digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        version = "catalog-a"
        write_catalog_cache(
            cache_path,
            digest=digest,
            version=version,
            firewalls={
                "mutable": cache_firewall(
                    "mutable",
                    "https://cache.example.com",
                    rules=["GET /items"],
                )
            },
        )
        os.utime(cache_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            write_catalog_cache(
                cache_path,
                digest=digest,
                version=version,
                firewalls={
                    "mutable": cache_firewall(
                        "mutable",
                        "https://cache.example.com",
                        rules=["POST /items"],
                    )
                },
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        _first_vm_info, first_compiled, first_policies = first_context
        _second_vm_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)
        first_result = matching.match_compiled_firewall_request(
            "https://cache.example.com/items",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://cache.example.com/items",
            "GET",
            second_compiled,
            second_policies,
        )
        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallBlock)
        assert second_result.reason == "unknown_endpoint"
