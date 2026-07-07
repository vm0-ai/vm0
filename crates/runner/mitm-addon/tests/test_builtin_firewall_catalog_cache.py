"""Tests for runner-local builtin firewall catalog cache resolution."""

import json

import builtin_host_policy
import registry
import registry_firewalls
from tests.registry_helpers import builtin_vm, write_multi_vm_registry


def _firewall(name: str, base: str) -> dict:
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
                "permissions": [],
                "hostPolicy": {"kind": "publicDestination"},
            }
        ],
    }


def _write_cache(path, *, name: str, base: str) -> None:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "updatedAt": "2026-07-07T00:00:00.000Z",
                "entries": {
                    name: {
                        "catalogDigest": "sha256:test",
                        "catalogVersion": "test.1",
                        "firewall": _firewall(name, base),
                    }
                },
            }
        )
    )


def _install_bundled(monkeypatch, *, name: str, base: str) -> None:
    monkeypatch.setattr(
        registry_firewalls,
        "BUILTIN_FIREWALLS",
        {name: _firewall(name, base)},
    )


def test_local_cache_entry_is_preferred_over_bundled_catalog(tmp_path, monkeypatch, mitm_ctx):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-cache.json"
    _install_bundled(monkeypatch, name="demo", base="https://bundled.example.com")
    _write_cache(cache_path, name="demo", base="https://cached.example.com")
    write_multi_vm_registry(registry_path, {"10.200.0.1": builtin_vm("run-demo", "demo")})

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_cache_path=str(cache_path),
    ):
        context = registry.get_vm_context("10.200.0.1", str(registry_path))

    assert context is not None
    vm_info, _, _ = context
    api = vm_info["firewalls"][0]["apis"][0]
    assert api["base"] == "https://cached.example.com"
    assert api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] is True


def test_malformed_cache_falls_back_to_bundled_catalog(tmp_path, monkeypatch, mitm_ctx):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-cache.json"
    _install_bundled(monkeypatch, name="demo", base="https://bundled.example.com")
    cache_path.write_text("{not json")
    write_multi_vm_registry(registry_path, {"10.200.0.1": builtin_vm("run-demo", "demo")})

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_cache_path=str(cache_path),
    ):
        context = registry.get_vm_context("10.200.0.1", str(registry_path))

    assert context is not None
    vm_info, _, _ = context
    assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"


def test_invalid_cache_entry_falls_back_to_bundled_catalog(tmp_path, monkeypatch, mitm_ctx):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-cache.json"
    _install_bundled(monkeypatch, name="demo", base="https://bundled.example.com")
    cache_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "updatedAt": "2026-07-07T00:00:00.000Z",
                "entries": {
                    "demo": {
                        "catalogDigest": "sha256:test",
                        "catalogVersion": "test.1",
                        "firewall": {"name": "demo", "apis": "not-a-list"},
                    }
                },
            }
        )
    )
    write_multi_vm_registry(registry_path, {"10.200.0.1": builtin_vm("run-demo", "demo")})

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_cache_path=str(cache_path),
    ):
        context = registry.get_vm_context("10.200.0.1", str(registry_path))

    assert context is not None
    vm_info, _, _ = context
    assert vm_info["firewalls"][0]["apis"][0]["base"] == "https://bundled.example.com"


def test_cache_file_change_reloads_registry_context_without_registry_change(
    tmp_path, monkeypatch, mitm_ctx
):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-cache.json"
    _install_bundled(monkeypatch, name="demo", base="https://bundled.example.com")
    write_multi_vm_registry(registry_path, {"10.200.0.1": builtin_vm("run-demo", "demo")})
    _write_cache(cache_path, name="demo", base="https://old-cache.example.com")

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_cache_path=str(cache_path),
    ):
        first = registry.get_vm_context("10.200.0.1", str(registry_path))
        _write_cache(cache_path, name="demo", base="https://new-cache.example.com/longer")
        second = registry.get_vm_context("10.200.0.1", str(registry_path))

    assert first is not None
    assert second is not None
    first_vm, _, _ = first
    second_vm, _, _ = second
    assert first_vm["firewalls"][0]["apis"][0]["base"] == "https://old-cache.example.com"
    assert second_vm["firewalls"][0]["apis"][0]["base"] == "https://new-cache.example.com/longer"
