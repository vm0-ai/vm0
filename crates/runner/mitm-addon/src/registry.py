"""Proxy registry loading and VM lookup cache."""

import json
from pathlib import Path

from mitmproxy import ctx

from auth import evict_stale_cache_keys

# Cache for proxy registry (invalidated by file stat change).
_registry_cache: dict = {}
_registry_cache_key: tuple[int, int] = (0, 0)
# One-shot guard for stat-path failures: no cache key is available in that
# branch, so we fall back to a flag (mirrors counters.py:_pending_write_error_logged).
# Parse-path failures use the cache key itself — recording the bad file's
# (mtime_ns, size) as already-processed prevents re-parsing the same bytes
# on every request and re-warning about them.
_registry_load_error_logged = False


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    global _registry_cache, _registry_cache_key, _registry_load_error_logged
    _registry_cache = {}
    _registry_cache_key = (0, 0)
    _registry_load_error_logged = False


def load_registry(registry_path: str) -> dict:
    """Load the proxy registry from file, with stat-based cache invalidation."""
    global _registry_cache, _registry_cache_key, _registry_load_error_logged

    path = Path(registry_path)
    try:
        st = path.stat()
    except OSError as e:
        if not _registry_load_error_logged:
            _registry_load_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {e}")
        return _registry_cache

    key = (st.st_mtime_ns, st.st_size)
    if key == _registry_cache_key:
        return _registry_cache

    try:
        with path.open() as f:
            new_registry = json.load(f).get("vms", {})

        # Evict cache entries for runs no longer in the registry.
        active_run_ids = {run_id for vm in new_registry.values() if (run_id := vm.get("runId"))}
        evict_stale_cache_keys(active_run_ids)

        _registry_cache = new_registry
        _registry_load_error_logged = False
    except Exception as e:
        if not _registry_load_error_logged:
            _registry_load_error_logged = True
            ctx.log.warn(f"Failed to parse proxy registry: {e}")

    # Record this file state as already processed — success or parse failure —
    # so subsequent requests on the same bytes short-circuit at the key check.
    _registry_cache_key = key
    return _registry_cache


def get_vm_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up VM info by client IP address."""
    return load_registry(registry_path).get(client_ip)
