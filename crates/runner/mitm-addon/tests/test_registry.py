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
