"""Tests for registry built-in firewall resolution and core-cache behavior."""

import json
import os
from unittest.mock import MagicMock, patch

import builtin_firewall_cache
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


def _cache_firewall(name: str, base: str, *, rules: list[str] | None = None) -> dict:
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": [base.removeprefix("https://")],
                },
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                },
                "permissions": [{"name": "read", "rules": rules or ["GET /items"]}],
            }
        ],
    }


def _write_catalog_cache(
    path,
    *,
    digest: str,
    version: str,
    firewalls: dict[str, dict],
) -> None:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "catalogDigest": digest,
                "catalogVersion": version,
                "updatedAt": "2026-07-07T00:00:00.000Z",
                "firewalls": firewalls,
            },
            sort_keys=True,
        )
    )


def _catalog_snapshot(
    *,
    digest_char: str,
    version: str,
    firewalls: dict[str, dict],
) -> builtin_firewall_cache.BuiltinFirewallCatalogSnapshot:
    key = (f"catalog-cache/{version}.json", 1, 1, len(version), len(firewalls))
    digest = f"sha256:{digest_char * 64}"
    return builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
        dependency_file_key=key,
        catalog=builtin_firewall_cache.BuiltinFirewallCatalog(
            identity=("cache", digest, version, key),
            firewalls=firewalls,
        ),
    )


def _assert_cache_firewall_falls_back_to_bundled(
    tmp_path,
    monkeypatch,
    mitm_ctx,
    firewall: dict,
    *,
    cache_mode: int | None = None,
) -> None:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    monkeypatch.setattr(
        registry_firewalls,
        "BUILTIN_FIREWALLS",
        {
            "fallback": {
                "name": "fallback",
                "apis": [
                    {
                        "base": "https://bundled.example.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "read", "rules": ["GET /items"]}],
                    }
                ],
            }
        },
    )
    _write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={"fallback": firewall},
    )
    if cache_mode is not None:
        cache_path.chmod(cache_mode)
    write_multi_vm_registry(
        registry_path,
        {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
    )

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        context = registry.get_vm_context("10.200.0.1", str(registry_path))

    assert context is not None
    vm_info, compiled_firewalls, _ = context
    assert compiled_firewalls is not None
    assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"


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

    def test_builtin_firewall_entry_prefers_runner_catalog_cache(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "cache-only": _cache_firewall(
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
        assert api["_builtinHostPolicyRuntime"] is True

    def test_catalog_api_ids_are_reassigned_per_vm(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        firewall = _cache_firewall("cache-only", "https://cache-only.example.com")
        firewall["apis"][0]["id"] = "catalog-owned-id"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-cache-only", "cache-only")},
        )
        _write_catalog_cache(
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

    def test_registry_snapshot_uses_actual_loaded_catalog_file_key(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-racy-cache", "racy-cache")},
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "racy-cache": _cache_firewall(
                    "racy-cache",
                    "https://cache.example.com",
                )
            },
        )
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "racy-cache": {
                    "name": "racy-cache",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
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

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_builtin_registry_reload_when_catalog_cache_appears(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-late-cache", "late-cache")},
        )
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "late-cache": {
                    "name": "late-cache",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            _write_catalog_cache(
                cache_path,
                digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                version="catalog-a",
                firewalls={
                    "late-cache": _cache_firewall(
                        "late-cache",
                        "https://cache.example.com",
                    )
                },
            )
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, _ = first_context
        second_vm_info, second_compiled, _ = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"
        assert second_vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache.example.com"
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)

    def test_unknown_builtin_registry_reload_when_catalog_cache_appears(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(registry_firewalls, "BUILTIN_FIREWALLS", {})
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
            _write_catalog_cache(
                cache_path,
                digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                version="catalog-a",
                firewalls={
                    "cache-only": _cache_firewall(
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

    def test_missing_runner_catalog_cache_logs_bundled_fallback_once(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        cache_path = tmp_path / "missing-builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
            dependency_file_key=None,
            catalog=None,
            cache_path=str(cache_path),
            fallback_reason="cache_file_missing",
        )

        with mitm_ctx() as log:
            for _ in range(2):
                resolved = registry_firewalls.resolve_firewall_entries(
                    builtin_vm("run-fallback", "fallback"),
                    builtin_firewall_catalog_snapshot=snapshot,
                )
                assert resolved.firewalls is not None
                assert resolved.firewalls[0]["apis"][0]["base"] == "https://bundled.example.com"

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Using bundled builtin firewall fallback" in warning
        assert "reason=cache_file_missing" in warning
        assert "firewall_name=fallback" in warning
        assert f"cache_path={cache_path}" in warning

    def test_runner_catalog_cache_missing_firewall_logs_bundled_fallback(
        self, monkeypatch, mitm_ctx
    ):
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        snapshot = _catalog_snapshot(
            digest_char="a",
            version="catalog-a",
            firewalls={
                "other": _cache_firewall(
                    "other",
                    "https://cache.example.com",
                )
            },
        )
        rewritten_snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
            dependency_file_key=("catalog-cache/catalog-a.json", 1, 2, 3, 4),
            catalog=snapshot.catalog,
        )

        with mitm_ctx() as log:
            for current_snapshot in (snapshot, rewritten_snapshot):
                resolved = registry_firewalls.resolve_firewall_entries(
                    builtin_vm("run-fallback", "fallback"),
                    builtin_firewall_catalog_snapshot=current_snapshot,
                )
                assert resolved.firewalls is not None
                assert resolved.firewalls[0]["apis"][0]["base"] == "https://bundled.example.com"

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Using bundled builtin firewall fallback" in warning
        assert "reason=cache_missing_firewall" in warning
        assert "firewall_name=fallback" in warning
        assert (
            "catalog_digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            in warning
        )
        assert "catalog_version=catalog-a" in warning
        assert "cache_file_key=" not in warning

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
        monkeypatch.setattr(registry_firewalls, "BUILTIN_FIREWALLS", {})
        snapshots = [
            _catalog_snapshot(
                digest_char="a",
                version="catalog-a",
                firewalls={
                    "alpha": _cache_firewall("alpha", "https://alpha-a.example.com"),
                    "beta": _cache_firewall("beta", "https://beta-a.example.com"),
                },
            ),
            _catalog_snapshot(
                digest_char="b",
                version="catalog-b",
                firewalls={
                    "alpha": _cache_firewall("alpha", "https://alpha-b.example.com"),
                    "beta": _cache_firewall("beta", "https://beta-b.example.com"),
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

    def test_runner_catalog_cache_accepts_valid_template_base(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {
                "10.200.0.1": builtin_vm(
                    "run-template",
                    "templated",
                    {"TENANT": "acme"},
                )
            },
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": "https://${{ vars.TENANT }}.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
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
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://acme.example.com"

    def test_malformed_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        cache_path.write_text('{"schemaVersion":1}')
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_empty_api_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": {"name": "fallback", "apis": []}},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_static_base_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "not-a-url"
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_parameterized_base_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://api.{tenant+}.example.com"
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_template_base_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ secrets.TENANT }}.example.com"
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_template_parameter_base_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.TENANT }}.{tenant+}.example.com"
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_non_ascii_template_variable_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.\u00e9 }}.example.com"
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_auth_base_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["auth"] = {"base": "http://auth.example.com"}

        _assert_cache_firewall_falls_back_to_bundled(
            tmp_path,
            monkeypatch,
            mitm_ctx,
            firewall,
        )

    def test_world_writable_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        firewall = _cache_firewall("fallback", "https://cache.example.com")

        _assert_cache_firewall_falls_back_to_bundled(
            tmp_path,
            monkeypatch,
            mitm_ctx,
            firewall,
            cache_mode=0o666,
        )

    def test_world_writable_runner_catalog_cache_logs_untrusted_fallback(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": _cache_firewall("fallback", "https://cache.example.com")},
        )
        cache_path.chmod(0o666)
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ) as log:
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"
        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Using bundled builtin firewall fallback" in warning
        assert "reason=cache_untrusted" in warning
        assert "firewall_name=fallback" in warning
        assert f"cache_path={cache_path}" in warning

    def test_malformed_aws_sigv4_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        del firewall["apis"][0]["auth"]["awsSigv4"]["secretAccessKey"]

        _assert_cache_firewall_falls_back_to_bundled(
            tmp_path,
            monkeypatch,
            mitm_ctx,
            firewall,
        )

    def test_malformed_host_policy_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["hostPolicy"] = {
            "kind": "providerOwned",
            "exactHosts": ["127.0.0.1"],
        }

        _assert_cache_firewall_falls_back_to_bundled(
            tmp_path,
            monkeypatch,
            mitm_ctx,
            firewall,
        )

    def test_malformed_permission_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = []
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_malformed_rule_runner_catalog_cache_falls_back_to_bundled(
        self, tmp_path, monkeypatch, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        monkeypatch.setattr(
            registry_firewalls,
            "BUILTIN_FIREWALLS",
            {
                "fallback": {
                    "name": "fallback",
                    "apis": [
                        {
                            "base": "https://bundled.example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )
        firewall = _cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = ["GET /items/{path+}/tail"]
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": firewall},
        )
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-fallback", "fallback")},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"

    def test_runner_catalog_cache_change_invalidates_registry_snapshot(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": builtin_vm("run-mutable", "mutable")},
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"mutable": _cache_firewall("mutable", "https://cache-a.example.com")},
        )
        os.utime(cache_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            _write_catalog_cache(
                cache_path,
                digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version="catalog-b",
                firewalls={"mutable": _cache_firewall("mutable", "https://cache-b.example.com")},
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        first_vm_info, first_compiled, _ = first_context
        second_vm_info, second_compiled, _ = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache-a.example.com"
        assert second_vm_info["firewalls"][0]["apis"][0]["base"] == "https://cache-b.example.com"
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)

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
        _write_catalog_cache(
            cache_path,
            digest=digest,
            version=version,
            firewalls={
                "mutable": _cache_firewall(
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
            _write_catalog_cache(
                cache_path,
                digest=digest,
                version=version,
                firewalls={
                    "mutable": _cache_firewall(
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
        assert _first_firewall_core(first_compiled) is not _first_firewall_core(second_compiled)
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

    def test_inline_only_registry_ignores_catalog_cache_changes(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_vm_registry(
            registry_path,
            {"10.200.0.1": inline_vm("run-inline")},
        )
        _write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"unused": _cache_firewall("unused", "https://unused-a.example.com")},
        )
        os.utime(cache_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_vm_context("10.200.0.1", str(registry_path))
            _write_catalog_cache(
                cache_path,
                digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version="catalog-b",
                firewalls={"unused": _cache_firewall("unused", "https://unused-b.example.com")},
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_vm_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        _first_vm_info, first_compiled, _first_policies = first_context
        _second_vm_info, second_compiled, _second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert _first_firewall_core(first_compiled) is _first_firewall_core(second_compiled)

    def test_inline_firewall_api_ids_are_preserved(self, tmp_path):
        path = tmp_path / "registry.json"
        vm = inline_vm("run-inline")
        vm["firewalls"][0]["firewall"]["apis"][0]["id"] = "custom-api-id"
        write_multi_vm_registry(path, {"10.200.0.1": vm})

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        vm_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert vm_info["firewalls"][0]["apis"][0]["id"] == "custom-api-id"
