"""Tests for registry loading, caching, and network logging."""

import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import auth
import mitm_addon


def _reset_cache():
    """Reset the module-level registry cache between tests."""
    mitm_addon._registry_cache = {}
    mitm_addon._registry_cache_key = (0, 0)
    mitm_addon._registry_load_error_logged = False
    auth._firewall_header_cache.clear()
    auth._cache_locks.clear()


class TestLoadRegistry:
    def setup_method(self):
        _reset_cache()

    def test_loads_valid_registry(self, registry_file):
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            result = mitm_addon.load_registry()

        assert "10.200.0.1" in result
        assert result["10.200.0.1"]["runId"] == "run-abc-123"

    def test_missing_file_returns_empty(self, tmp_path):
        missing = str(tmp_path / "nonexistent.json")
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=missing),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            result = mitm_addon.load_registry()

        assert result == {}

    def test_cache_returns_same_on_unchanged(self, registry_file):
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            result1 = mitm_addon.load_registry()
            result2 = mitm_addon.load_registry()

        assert result1 is result2

    def test_cache_invalidated_on_change(self, registry_file):
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            result1 = mitm_addon.load_registry()
            assert "10.200.0.1" in result1

            # Modify the file
            new_data = {"vms": {"10.200.0.99": {"runId": "new-run"}}, "updatedAt": 0}
            registry_file.write_text(json.dumps(new_data))

            result2 = mitm_addon.load_registry()
            assert "10.200.0.99" in result2
            assert "10.200.0.1" not in result2

    def test_missing_file_logs_once_across_calls(self, tmp_path):
        """Stat-path failures repeated across requests emit at most one warn."""
        missing = str(tmp_path / "nonexistent.json")
        log = MagicMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=missing),
            patch.object(mitm_addon.ctx, "log", log, create=True),
        ):
            for _ in range(5):
                assert mitm_addon.load_registry() == {}

        assert log.warn.call_count == 1
        assert "Failed to stat" in log.warn.call_args_list[0].args[0]

    def test_parse_failure_logs_once_and_does_not_reparse(self, tmp_path):
        """Parse failure on a fixed file: key match short-circuits re-parse."""
        bad = tmp_path / "bad.json"
        bad.write_text("{ not valid json")
        log = MagicMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(bad)),
            patch.object(mitm_addon.ctx, "log", log, create=True),
            patch.object(mitm_addon.json, "load", wraps=mitm_addon.json.load) as spy,
        ):
            for _ in range(5):
                assert mitm_addon.load_registry() == {}

        assert spy.call_count == 1
        assert log.warn.call_count == 1
        assert "Failed to parse" in log.warn.call_args_list[0].args[0]

    def test_recovery_after_parse_failure_rewarns_on_next_failure(self, tmp_path):
        """Successful load clears the flag so a later failure re-warns once."""
        path = tmp_path / "registry.json"
        path.write_text("{ broken")
        log = MagicMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(path)),
            patch.object(mitm_addon.ctx, "log", log, create=True),
        ):
            mitm_addon.load_registry()  # parse fails → warn #1
            assert log.warn.call_count == 1

            # File becomes valid → successful load clears the flag.
            path.write_text(json.dumps({"vms": {"10.0.0.1": {"runId": "r1"}}}))
            result = mitm_addon.load_registry()
            assert "10.0.0.1" in result
            assert log.warn.call_count == 1  # no new warn on success

            # File breaks again. Different size than the good content above
            # busts the cache key so the parse re-runs; the successful load
            # reset the flag, so this failure warns again.
            path.write_text("{ broken again, different size")
            mitm_addon.load_registry()
            assert log.warn.call_count == 2

    def test_evicts_header_cache_on_run_removal(self, registry_file):
        """When a run disappears from registry, its header cache entries are evicted."""
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            mitm_addon.load_registry()  # initial load (has run-abc-123)

            # Simulate cached headers, locks, markers, and refresh timestamps
            # for run-abc-123
            auth._firewall_header_cache[("run-abc-123", "api-0")] = {
                "headers": {"Authorization": "Bearer tok"},
            }
            auth._cache_locks[("run-abc-123", "api-0")] = asyncio.Lock()
            auth._force_refresh_markers.add(("run-abc-123", "api-0"))
            auth._last_force_refresh_at[("run-abc-123", "api-0")] = 100.0
            # Also cache for run-other (will appear in new registry)
            auth._firewall_header_cache[("run-other", "api-0")] = {
                "headers": {"Authorization": "Bearer other"},
            }
            auth._cache_locks[("run-other", "api-0")] = asyncio.Lock()
            auth._force_refresh_markers.add(("run-other", "api-0"))
            auth._last_force_refresh_at[("run-other", "api-0")] = 200.0

            # Update registry: remove run-abc-123, add run-other
            new_data = {"vms": {"10.200.0.99": {"runId": "run-other"}}, "updatedAt": 0}
            registry_file.write_text(json.dumps(new_data))

            mitm_addon.load_registry()  # reload triggers eviction

        # run-abc-123 state should be evicted (no longer in registry)
        assert ("run-abc-123", "api-0") not in auth._firewall_header_cache
        assert ("run-abc-123", "api-0") not in auth._cache_locks
        assert ("run-abc-123", "api-0") not in auth._force_refresh_markers
        assert ("run-abc-123", "api-0") not in auth._last_force_refresh_at
        # run-other state should remain (still in registry)
        assert ("run-other", "api-0") in auth._firewall_header_cache
        assert ("run-other", "api-0") in auth._cache_locks
        assert ("run-other", "api-0") in auth._force_refresh_markers
        assert ("run-other", "api-0") in auth._last_force_refresh_at


class TestGetVmInfo:
    def setup_method(self):
        _reset_cache()

    def test_known_ip(self, registry_file):
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            info = mitm_addon.get_vm_info("10.200.0.1")

        assert info is not None
        assert info["runId"] == "run-abc-123"

    def test_unknown_ip(self, registry_file):
        with patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)):
            info = mitm_addon.get_vm_info("192.168.1.1")

        assert info is None


class TestLogNetworkEntry:
    def test_writes_jsonl(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"action": "ALLOW", "host": "example.com"}

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.log_network_entry(log_path, entry)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["action"] == "ALLOW"
        assert parsed["host"] == "example.com"

    def test_appends_multiple(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.log_network_entry(log_path, {"n": 1})
            mitm_addon.log_network_entry(log_path, {"n": 2})

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 2

    def test_no_path_is_noop(self):
        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.log_network_entry("", {"action": "ALLOW"})
