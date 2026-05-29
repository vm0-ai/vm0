"""Proxy registry loading and VM lookup cache."""

import json
from pathlib import Path

from mitmproxy import ctx

import matching
from auth import evict_stale_cache_keys

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]

# Cache for proxy registry (invalidated by file stat change).
_registry_cache: dict = {}
_registry_compiled_cache: dict[str, matching.CompiledFirewallSet] = {}
_registry_compiled_policy_cache: dict[str, matching.CompiledNetworkPolicies] = {}
_registry_cache_key: tuple[int, int] = (0, 0)
# One-shot guard for stat-path failures: no cache key is available in that
# branch, so we fall back to a flag (mirrors counters.py:_pending_write_error_logged).
# Parse-path failures use the cache key itself — recording the bad file's
# (mtime_ns, size) as already-processed prevents re-parsing the same bytes
# on every request and re-warning about them.
_registry_load_error_logged = False


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    global _registry_cache, _registry_compiled_cache, _registry_compiled_policy_cache
    global _registry_cache_key
    global _registry_load_error_logged
    _registry_cache = {}
    _registry_compiled_cache = {}
    _registry_compiled_policy_cache = {}
    _registry_cache_key = (0, 0)
    _registry_load_error_logged = False


def _compile_registry(
    new_registry: dict,
) -> tuple[
    dict[str, matching.CompiledFirewallSet],
    dict[str, matching.CompiledNetworkPolicies],
]:
    compiled_firewall_registry: dict[str, matching.CompiledFirewallSet] = {}
    compiled_policy_registry: dict[str, matching.CompiledNetworkPolicies] = {}
    for client_ip, vm in new_registry.items():
        firewalls = vm.get("firewalls") if isinstance(vm, dict) else None
        compiled_firewalls = matching.compile_firewalls(firewalls)
        if compiled_firewalls is not None:
            compiled_firewall_registry[client_ip] = compiled_firewalls
        network_policies = vm.get("networkPolicies") if isinstance(vm, dict) else None
        compiled_policy_registry[client_ip] = matching.compile_network_policies(network_policies)
    return compiled_firewall_registry, compiled_policy_registry


def _normalize_registry_vms(raw_registry: object) -> tuple[dict, int]:
    if not isinstance(raw_registry, dict):
        raise TypeError("proxy registry vms must be an object")

    new_registry = {client_ip: vm for client_ip, vm in raw_registry.items() if isinstance(vm, dict)}
    return new_registry, len(raw_registry) - len(new_registry)


def load_registry(registry_path: str) -> dict:
    """Load the proxy registry, reusing cached data when possible.

    The registry is reloaded only when file stat metadata changes. If stat
    fails, the current registry cache is returned. If processing a changed file
    fails, the current cache is preserved and returned, and that file state is
    recorded as processed so repeated reads short-circuit on the same stat key.
    Failures are warning-logged at most once until a successful reload clears
    the error state. A successful reload also evicts firewall-auth cache
    entries for run IDs no longer present in the registry.
    """
    global _registry_cache, _registry_compiled_cache, _registry_compiled_policy_cache
    global _registry_cache_key
    global _registry_load_error_logged

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
            raw_registry = json.load(f).get("vms", {})
        new_registry, malformed_vm_count = _normalize_registry_vms(raw_registry)
        if malformed_vm_count:
            ctx.log.warn(f"Skipped {malformed_vm_count} malformed proxy registry VM entries")
        new_compiled_registry, new_compiled_policy_registry = _compile_registry(new_registry)

        # Evict cache entries for runs no longer in the registry.
        active_run_ids = {
            run_id
            for vm in new_registry.values()
            if isinstance(run_id := vm.get("runId"), str) and run_id
        }
        evict_stale_cache_keys(active_run_ids)

        _registry_cache = new_registry
        _registry_compiled_cache = new_compiled_registry
        _registry_compiled_policy_cache = new_compiled_policy_registry
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


def get_vm_context(
    client_ip: str,
    registry_path: str,
) -> VmContext | None:
    """Look up raw VM info with compiled firewall and policy matcher sidecars."""
    vm_info = load_registry(registry_path).get(client_ip)
    if vm_info is None:
        return None
    compiled_network_policies = _registry_compiled_policy_cache.get(client_ip)
    if compiled_network_policies is None:
        compiled_network_policies = matching.compile_network_policies(
            vm_info.get("networkPolicies")
        )
    return vm_info, _registry_compiled_cache.get(client_ip), compiled_network_policies
