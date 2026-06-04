"""Tests for registry loading and caching."""

import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import matching
import registry
from tests.auth_state_helpers import (
    cached_headers,
    clear_auth_state,
    force_refresh_pending,
    has_auth_state,
    last_force_refresh_at,
    mark_force_refresh,
    set_cached_headers,
    set_last_force_refresh_at,
)

_FIXED_MTIME_NS = 1_700_000_000_000_000_000


def _reset_cache():
    """Reset the module-level registry cache between tests."""
    registry.reset_cache_for_tests()
    clear_auth_state()


def _write_simple_registry(path, *, run_id="run-one"):
    data = {
        "vms": {"10.200.0.1": {"runId": run_id}},
        "updatedAt": 0,
    }
    path.write_text(json.dumps(data, sort_keys=True))


def _pin_mtime(path):
    os.utime(path, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))


def _write_firewall_registry(path, *, rule="/items"):
    data = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "firewalls": [
                    {
                        "name": "example",
                        "apis": [
                            {
                                "base": "https://api.example.com",
                                "auth": {"headers": {"Authorization": "Bearer token"}},
                                "permissions": [
                                    {"name": "read", "rules": [f"GET {rule}"]},
                                ],
                            }
                        ],
                    }
                ],
                "networkPolicies": {
                    "example": {
                        "allow": ["read"],
                        "deny": [],
                        "unknownPolicy": "deny",
                    }
                },
            }
        },
        "updatedAt": 1700000000000,
    }
    path.write_text(json.dumps(data))


class TestLoadRegistry:
    def setup_method(self):
        _reset_cache()

    def test_loads_valid_registry(self, registry_file):
        result = registry.load_registry(str(registry_file))

        assert "10.200.0.1" in result
        assert result["10.200.0.1"]["runId"] == "run-abc-123"

    def test_classifies_invalid_registered_vm_entries(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "run-active"},
                        "10.200.0.2": "broken",
                        "10.200.0.3": {},
                        "10.200.0.4": {"runId": ""},
                        "10.200.0.5": {"runId": 123},
                        "10.200.0.6": {"runId": "  \t"},
                        "10.200.0.7": {"runId": " run-active "},
                    },
                    "updatedAt": 0,
                }
            )
        )

        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            state = registry.load_registry_state(str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.vms) == {"10.200.0.1"}
        assert set(state.invalid_vms) == {
            "10.200.0.2",
            "10.200.0.3",
            "10.200.0.4",
            "10.200.0.5",
            "10.200.0.6",
            "10.200.0.7",
        }
        assert state.invalid_vms["10.200.0.2"].reason == "invalid_vm_entry"
        assert state.invalid_vms["10.200.0.3"].reason == "missing_run_id"
        assert state.invalid_vms["10.200.0.4"].reason == "empty_run_id"
        assert state.invalid_vms["10.200.0.5"].reason == "invalid_run_id"
        assert state.invalid_vms["10.200.0.6"].reason == "empty_run_id"
        assert state.invalid_vms["10.200.0.7"].reason == "invalid_run_id"

    def test_missing_file_returns_empty(self, tmp_path):
        missing = str(tmp_path / "nonexistent.json")
        with patch.object(registry.ctx, "log", MagicMock(), create=True):
            result = registry.load_registry(missing)
            state = registry.load_registry_state(missing)

        assert result == {}
        assert isinstance(state, registry.RegistryUnavailable)

    def test_cache_returns_same_on_unchanged(self, registry_file):
        result1 = registry.load_registry(str(registry_file))
        result2 = registry.load_registry(str(registry_file))

        assert result1 is result2

    def test_cache_invalidated_on_change(self, registry_file):
        result1 = registry.load_registry(str(registry_file))
        assert "10.200.0.1" in result1

        # Modify the file
        new_data = {"vms": {"10.200.0.99": {"runId": "new-run"}}, "updatedAt": 0}
        registry_file.write_text(json.dumps(new_data))

        result2 = registry.load_registry(str(registry_file))
        assert "10.200.0.99" in result2
        assert "10.200.0.1" not in result2

    def test_cache_is_scoped_to_registry_path(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        _write_simple_registry(path_a, run_id="run-one")
        _write_simple_registry(path_b, run_id="run-two")
        _pin_mtime(path_a)
        _pin_mtime(path_b)
        assert path_a.stat().st_size == path_b.stat().st_size

        first = registry.load_registry(str(path_a))
        second = registry.load_registry(str(path_b))

        assert first["10.200.0.1"]["runId"] == "run-one"
        assert second["10.200.0.1"]["runId"] == "run-two"
        assert second is not first

    def test_registry_path_switch_evicts_header_cache(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        _write_simple_registry(path_a, run_id="run-one")
        _write_simple_registry(path_b, run_id="run-two")
        registry.load_registry(str(path_a))
        set_cached_headers(
            ("run-one", "api-0"),
            headers={"Authorization": "Bearer old"},
        )

        registry.load_registry(str(path_b))

        assert not has_auth_state(("run-one", "api-0"))

    def test_missing_different_path_does_not_return_previous_cache(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        missing_b = tmp_path / "registry-b.json"
        _write_simple_registry(path_a)
        registry.load_registry(str(path_a))

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result = registry.load_registry(str(missing_b))

        assert result == {}
        assert log.warn.call_count == 1
        assert "registry-b.json" in log.warn.call_args_list[0].args[0]

    def test_atomic_replacement_reloads_same_size_same_mtime_registry(self, tmp_path):
        path = tmp_path / "registry.json"
        replacement = tmp_path / "registry.json.tmp"
        _write_simple_registry(path, run_id="run-one")
        _pin_mtime(path)
        first = registry.load_registry(str(path))

        _write_simple_registry(replacement, run_id="run-two")
        assert replacement.stat().st_size == path.stat().st_size
        _pin_mtime(replacement)
        replacement.replace(path)

        second = registry.load_registry(str(path))

        assert first["10.200.0.1"]["runId"] == "run-one"
        assert second["10.200.0.1"]["runId"] == "run-two"
        assert second is not first

    def test_invalid_vm_entries_do_not_block_valid_vms(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "vms": {
                        "10.200.0.1": {"runId": "good-run"},
                        "10.200.0.2": None,
                        "10.200.0.3": "broken",
                        "10.200.0.4": ["broken"],
                        "10.200.0.5": 42,
                    },
                    "updatedAt": 0,
                }
            )
        )

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result = registry.load_registry(str(path))
            cached = registry.load_registry(str(path))

        assert result == {"10.200.0.1": {"runId": "good-run"}}
        assert cached is result
        assert log.warn.call_count == 1
        warning = log.warn.call_args_list[0].args[0]
        assert "Rejected 4 invalid proxy registry VM entries" in warning
        assert "10.200.0.2" not in warning
        assert "good-run" not in warning

    def test_missing_file_logs_once_across_calls(self, tmp_path):
        """Stat-path failures repeated across requests emit at most one warn."""
        missing = str(tmp_path / "nonexistent.json")
        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            for _ in range(5):
                assert registry.load_registry(missing) == {}

        assert log.warn.call_count == 1
        assert "Failed to stat" in log.warn.call_args_list[0].args[0]

    def test_missing_file_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.unlink()

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "stat_failed"
        assert log.warn.call_count == 1
        assert "Failed to stat" in log.warn.call_args_list[0].args[0]

    def test_parse_failure_logs_once_and_does_not_reparse(self, tmp_path):
        """Parse failure on a fixed file: key match short-circuits re-parse."""
        bad = tmp_path / "bad.json"
        bad.write_text("{ not valid json")
        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "load", wraps=registry.json.load) as spy,
        ):
            for _ in range(5):
                assert registry.load_registry(str(bad)) == {}

        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_parse_failure_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text("{ not valid json after success")

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "load", wraps=registry.json.load) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_non_object_vms_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text(json.dumps({"vms": ["broken"], "updatedAt": 0}))

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "load", wraps=registry.json.load) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_non_object_registry_after_success_marks_registry_unavailable(self, registry_file):
        registry.load_registry(str(registry_file))
        registry_file.write_text(json.dumps(["broken"]))

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.json, "load", wraps=registry.json.load) as spy,
        ):
            result1 = registry.load_registry(str(registry_file))
            result2 = registry.load_registry(str(registry_file))
            state = registry.load_registry_state(str(registry_file))

        assert result1 == {}
        assert result2 == {}
        assert isinstance(state, registry.RegistryUnavailable)
        assert state.reason == "parse_failed"
        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_new_bad_registry_key_rewarns_without_success_between_failures(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text("{ broken")

        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            registry.load_registry(str(path))
            assert log.warn.call_count == 1

            path.write_text("{ broken again, different size")
            registry.load_registry(str(path))

        assert log.warn.call_count == 2
        assert all("Failed to parse" in call.args[0] for call in log.warn.call_args_list)

    def test_read_failure_after_stat_does_not_poison_file_key(self, registry_file):
        registry.load_registry(str(registry_file))
        new_registry = {"vms": {"10.200.0.99": {"runId": "new-run"}}, "updatedAt": 0}
        registry_file.write_text(json.dumps(new_registry))

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(
                registry.json,
                "load",
                side_effect=[OSError("read failed"), new_registry],
            ) as spy,
        ):
            failed = registry.load_registry(str(registry_file))
            recovered = registry.load_registry(str(registry_file))

        assert failed == {}
        assert recovered == {"10.200.0.99": {"runId": "new-run"}}
        assert spy.call_count == 2
        assert log.warn.call_count == 1
        assert "Failed to read" in log.warn.call_args_list[0].args[0]

    def test_read_failure_clears_previous_failed_key(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text("{}")
        first_key = SimpleNamespace(st_dev=1, st_ino=1, st_mtime_ns=100, st_size=10)
        second_key = SimpleNamespace(st_dev=1, st_ino=1, st_mtime_ns=200, st_size=20)
        valid_registry = {"vms": {"10.0.0.1": {"runId": "r1"}}}

        log = MagicMock()
        with (
            patch.object(registry.ctx, "log", log, create=True),
            patch.object(registry.Path, "stat", side_effect=[first_key, second_key, first_key]),
            patch.object(
                registry.json,
                "load",
                side_effect=[
                    json.JSONDecodeError("broken", "", 0),
                    OSError("read failed"),
                    valid_registry,
                ],
            ) as spy,
        ):
            assert registry.load_registry(str(path)) == {}
            assert registry.load_registry(str(path)) == {}
            recovered = registry.load_registry(str(path))

        assert recovered == {"10.0.0.1": {"runId": "r1"}}
        assert spy.call_count == 3
        assert log.warn.call_count == 2
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]
        assert "Failed to read" in log.warn.call_args_list[1].args[0]

    def test_recovery_after_parse_failure_rewarns_on_next_failure(self, tmp_path):
        """Successful load clears the flag so a later failure re-warns once."""
        path = tmp_path / "registry.json"
        path.write_text("{ broken")
        log = MagicMock()
        with patch.object(registry.ctx, "log", log, create=True):
            registry.load_registry(str(path))  # parse fails → warn #1
            assert log.warn.call_count == 1

            # File becomes valid → successful load clears the flag.
            path.write_text(json.dumps({"vms": {"10.0.0.1": {"runId": "r1"}}}))
            result = registry.load_registry(str(path))
            assert "10.0.0.1" in result
            assert log.warn.call_count == 1  # no new warn on success

            # File breaks again. Different size than the good content above
            # busts the cache key so the parse re-runs; the successful load
            # reset the flag, so this failure warns again.
            path.write_text("{ broken again, different size")
            registry.load_registry(str(path))
            assert log.warn.call_count == 2

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

    def test_parse_failure_evicts_header_cache_once(self, registry_file):
        """Unavailable registry clears auth state once when ownership is unknown."""
        registry.load_registry(str(registry_file))

        set_cached_headers(
            ("run-abc-123", "api-0"),
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(("run-abc-123", "api-0"))
        set_last_force_refresh_at(("run-abc-123", "api-0"), 100.0)

        registry_file.write_text("{ broken while evicting cache")

        with (
            patch.object(registry.ctx, "log", MagicMock(), create=True),
            patch.object(
                registry,
                "evict_all_cache_keys",
                wraps=registry.evict_all_cache_keys,
            ) as evict_spy,
        ):
            registry.load_registry(str(registry_file))
            registry.load_registry(str(registry_file))

        assert evict_spy.call_count == 1
        assert not has_auth_state(("run-abc-123", "api-0"))

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
        _write_firewall_registry(registry_file)

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


class TestGetVmInfo:
    def setup_method(self):
        _reset_cache()

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


class TestGetVmContext:
    def setup_method(self):
        _reset_cache()

    def test_returns_raw_info_and_compiled_firewall(self, tmp_path):
        path = tmp_path / "registry.json"
        _write_firewall_registry(path)

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
        _write_firewall_registry(path, rule="/items")
        first_context = registry.get_vm_context("10.200.0.1", str(path))
        assert first_context is not None
        first_vm_info, first_compiled, first_compiled_policies = first_context
        assert first_compiled is not None

        _write_firewall_registry(path, rule="/other-resource")
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
        _write_firewall_registry(path)
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
        _write_firewall_registry(path_a, rule="/items")
        _write_firewall_registry(path_b, rule="/other")
        _pin_mtime(path_a)
        _pin_mtime(path_b)
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
        _write_firewall_registry(path)
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
        _write_firewall_registry(path)
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
        _write_firewall_registry(path)
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
        _write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["firewalls"][0]["apis"][0]["permissions"][0]["rules"] = [
            "GET /items/{a}literal{b}"
        ]
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
        _write_firewall_registry(path)
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
        _write_firewall_registry(path)
        data = json.loads(path.read_text())
        data["vms"]["10.200.0.1"]["firewalls"] = None
        path.write_text(json.dumps(data))

        context = registry.get_vm_context("10.200.0.1", str(path))

        assert context is not None
        _, compiled_firewalls, compiled_network_policies = context
        assert compiled_firewalls is None
        assert compiled_network_policies is not None
