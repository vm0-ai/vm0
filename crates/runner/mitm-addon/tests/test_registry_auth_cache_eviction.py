"""Tests for registry-driven auth-cache eviction."""

import json
from unittest.mock import MagicMock, patch

import registry
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    last_force_refresh_at,
    mark_force_refresh,
    set_cached_headers,
    set_last_force_refresh_at,
)
from tests.registry_helpers import write_firewall_registry, write_simple_registry


class TestRegistryAuthCacheEviction:
    def test_registry_path_switch_evicts_header_cache(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        write_simple_registry(path_a, run_id="run-one")
        write_simple_registry(path_b, run_id="run-two")
        registry.load_registry(str(path_a))
        set_cached_headers(
            ("run-one", "api-0"),
            headers={"Authorization": "Bearer old"},
        )

        registry.load_registry(str(path_b))

        assert not has_auth_state(("run-one", "api-0"))

    def test_evicts_header_cache_on_run_removal(self, registry_file):
        """When a run disappears from registry, its header cache entries are evicted."""
        registry.load_registry(str(registry_file))  # initial load (has run-abc-123)

        # Simulate cached headers, locks, markers, and refresh timestamps
        # for run-abc-123
        set_cached_headers(
            ("run-abc-123", "api-0"),
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(("run-abc-123", "api-0"))
        set_last_force_refresh_at(("run-abc-123", "api-0"), 100.0)
        # Also cache for run-other (will appear in new registry)
        set_cached_headers(
            ("run-other", "api-0"),
            headers={"Authorization": "Bearer other"},
        )
        mark_force_refresh(("run-other", "api-0"))
        set_last_force_refresh_at(("run-other", "api-0"), 200.0)

        # Update registry: remove run-abc-123, add run-other
        new_data = {"vms": {"10.200.0.99": {"runId": "run-other"}}, "updatedAt": 0}
        registry_file.write_text(json.dumps(new_data))

        registry.load_registry(str(registry_file))  # reload triggers eviction

        # run-abc-123 state should be evicted (no longer in registry)
        assert not has_auth_state(("run-abc-123", "api-0"))
        # run-other state should remain (still in registry)
        assert cached_headers(("run-other", "api-0"))
        assert force_refresh_pending(("run-other", "api-0"))
        assert last_force_refresh_at(("run-other", "api-0")) == 200.0

    def test_repeated_parse_failure_does_not_re_evict_auth_state(
        self,
        registry_file,
    ):
        """Unavailable registry clears auth state once when ownership is unknown."""
        registry.load_registry(str(registry_file))

        old_cache_key = ("run-abc-123", "api-0")
        set_cached_headers(
            old_cache_key,
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(old_cache_key)
        set_last_force_refresh_at(old_cache_key, 100.0)

        registry_file.write_text("{ broken while evicting cache")

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            assert registry.load_registry(str(registry_file)) == {}

        assert not has_auth_state(old_cache_key)

        new_cache_key = ("run-after-failure", "api-0")
        set_cached_headers(
            new_cache_key,
            headers={"Authorization": "Bearer after-failure"},
        )
        mark_force_refresh(new_cache_key)
        set_last_force_refresh_at(new_cache_key, 200.0)

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            assert registry.load_registry(str(registry_file)) == {}

        assert cached_headers(new_cache_key)
        assert force_refresh_pending(new_cache_key)
        assert last_force_refresh_at(new_cache_key) == 200.0

    def test_evicts_marker_only_auth_state_on_run_removal(self, registry_file):
        """Registry eviction removes auth state even when it has no cached headers."""
        registry.load_registry(str(registry_file))

        mark_force_refresh(("run-abc-123", "api-0"))
        set_last_force_refresh_at(("run-abc-123", "api-0"), 100.0)

        registry_file.write_text(json.dumps({"vms": {}, "updatedAt": 0}))

        registry.load_registry(str(registry_file))

        assert not has_auth_state(("run-abc-123", "api-0"))

    def test_registry_entries_without_run_id_do_not_keep_header_cache(self, registry_file):
        """Registry entries with missing or blank runId are not active cache owners."""
        registry.load_registry(str(registry_file))

        set_cached_headers(("", "api-0"), headers={})
        mark_force_refresh(("", "api-0"))
        set_last_force_refresh_at(("", "api-0"), 100.0)
        set_cached_headers(("run-active", "api-0"), headers={})
        mark_force_refresh(("run-active", "api-0"))
        set_last_force_refresh_at(("run-active", "api-0"), 200.0)

        registry_file.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": ""},
                        "10.200.0.2": {},
                        "10.200.0.3": {"runId": "run-active"},
                        "10.200.0.4": {"runId": "  \t"},
                        "10.200.0.5": {"runId": " run-active "},
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            registry.load_registry(str(registry_file))

        assert not has_auth_state(("", "api-0"))
        assert cached_headers(("run-active", "api-0"))
        assert force_refresh_pending(("run-active", "api-0"))
        assert last_force_refresh_at(("run-active", "api-0")) == 200.0

    def test_valid_entry_becoming_invalid_evicts_context_and_cache(self, tmp_path):
        registry_file = tmp_path / "registry.json"
        write_firewall_registry(registry_file)

        context = registry.get_vm_context("10.200.0.1", str(registry_file))
        assert context is not None
        _, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        set_cached_headers(
            ("run-abc-123", "api-0"),
            headers={"Authorization": "Bearer tok"},
        )

        registry_file.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": ""},
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            state = registry.load_registry_state(str(registry_file))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.vms == {}
        assert set(state.invalid_vms) == {"10.200.0.1"}
        assert state.compiled_firewalls == {}
        assert state.compiled_network_policies == {}
        assert registry.get_vm_context("10.200.0.1", str(registry_file)) is None
        assert not has_auth_state(("run-abc-123", "api-0"))

    def test_invalid_vm_entries_do_not_block_header_cache_eviction(self, registry_file):
        """Invalid VM entries are not active cache owners."""
        registry.load_registry(str(registry_file))

        set_cached_headers(("run-old", "api-0"), headers={})
        mark_force_refresh(("run-old", "api-0"))
        set_last_force_refresh_at(("run-old", "api-0"), 100.0)
        set_cached_headers(("run-active", "api-0"), headers={})
        mark_force_refresh(("run-active", "api-0"))
        set_last_force_refresh_at(("run-active", "api-0"), 200.0)

        registry_file.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "run-active"},
                        "10.200.0.2": None,
                        "10.200.0.3": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            registry.load_registry(str(registry_file))

        assert not has_auth_state(("run-old", "api-0"))
        assert cached_headers(("run-active", "api-0"))
        assert force_refresh_pending(("run-active", "api-0"))
        assert last_force_refresh_at(("run-active", "api-0")) == 200.0
