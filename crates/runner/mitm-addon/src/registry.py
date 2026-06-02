"""Proxy registry loading and VM lookup cache."""

import json
from dataclasses import dataclass, field
from pathlib import Path

from mitmproxy import ctx

import matching
from auth import evict_stale_cache_keys

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
_RegistryCacheKey = tuple[str, int, int, int, int]


class _RegistryFormatError(ValueError):
    """Registry JSON decoded successfully but does not have the expected shape."""


@dataclass(frozen=True)
class _RegistrySnapshot:
    vms: dict
    compiled_firewalls: dict[str, matching.CompiledFirewallSet]
    compiled_network_policies: dict[str, matching.CompiledNetworkPolicies]
    loaded_key: _RegistryCacheKey | None


def _empty_snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot({}, {}, {}, None)


@dataclass
class _RegistryCacheState:
    registry_path: str | None = None
    # Successful registry state is stored in one snapshot so raw VM entries and
    # compiled matcher sidecars are published together.
    snapshot: _RegistrySnapshot = field(default_factory=_empty_snapshot)
    # Known-bad decoded registry input. Unlike the snapshot loaded key, this
    # means the current snapshot belongs to an older file state and this key
    # should short-circuit until the file changes again.
    failed_key: _RegistryCacheKey | None = None
    # Stat failures do not provide a key, so use a one-shot guard. Open/read
    # errors have a key but are retried on every call; track their last warning
    # key only to avoid request-path log spam without poisoning the file state.
    stat_error_logged: bool = False
    read_error_key: _RegistryCacheKey | None = None

    def reset(self, registry_path: str | None = None) -> None:
        self.registry_path = registry_path
        self.snapshot = _empty_snapshot()
        self.failed_key = None
        self.stat_error_logged = False
        self.read_error_key = None


_registry_state = _RegistryCacheState()


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    _registry_state.reset()


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _RegistryCacheState:
    if _registry_state.registry_path != path_key:
        _registry_state.reset(path_key)
    return _registry_state


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


def _normalize_registry_vms(raw_registry: dict) -> tuple[dict, int]:
    new_registry = {client_ip: vm for client_ip, vm in raw_registry.items() if isinstance(vm, dict)}
    return new_registry, len(raw_registry) - len(new_registry)


def _read_registry_vms(path: Path) -> dict:
    with path.open() as f:
        raw_registry = json.load(f)
    if not isinstance(raw_registry, dict):
        raise _RegistryFormatError("proxy registry must be an object")
    raw_vms = raw_registry.get("vms", {})
    if not isinstance(raw_vms, dict):
        raise _RegistryFormatError("proxy registry vms must be an object")
    return raw_vms


def _load_registry_snapshot(registry_path: str) -> _RegistrySnapshot:
    """Load the proxy registry snapshot, reusing cached data when possible.

    Cache state is scoped to one active registry path. A successful load
    publishes raw and compiled registry state together in a snapshot keyed by
    file identity metadata. Malformed registry input is recorded separately as
    a failed key so repeated reads of the same bad bytes do not reparse or
    re-warn. File read errors preserve the last snapshot but keep retrying that
    key, and internal compile/eviction errors are allowed to propagate instead
    of being treated as stale-cache parse failures.
    """
    path = Path(registry_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)

    try:
        st = path.stat()
    except OSError as e:
        if not state.stat_error_logged:
            state.stat_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {e}")
        return state.snapshot

    key = (path_key, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
    if key in (state.snapshot.loaded_key, state.failed_key):
        return state.snapshot

    try:
        raw_registry = _read_registry_vms(path)
    except OSError as e:
        state.failed_key = None
        if key != state.read_error_key:
            state.read_error_key = key
            ctx.log.warn(f"Failed to read proxy registry: {e}")
        return state.snapshot
    except (json.JSONDecodeError, UnicodeDecodeError, _RegistryFormatError) as e:
        state.failed_key = key
        state.read_error_key = None
        ctx.log.warn(f"Failed to parse proxy registry: {e}")
        return state.snapshot

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

    state.snapshot = _RegistrySnapshot(
        new_registry,
        new_compiled_registry,
        new_compiled_policy_registry,
        key,
    )
    state.failed_key = None
    state.stat_error_logged = False
    state.read_error_key = None
    return state.snapshot


def load_registry(registry_path: str) -> dict:
    """Load the proxy registry, reusing cached data when possible."""
    return _load_registry_snapshot(registry_path).vms


def get_vm_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up VM info by client IP address."""
    return load_registry(registry_path).get(client_ip)


def get_vm_context(
    client_ip: str,
    registry_path: str,
) -> VmContext | None:
    """Look up raw VM info with compiled firewall and policy matcher sidecars."""
    snapshot = _load_registry_snapshot(registry_path)
    vm_info = snapshot.vms.get(client_ip)
    if vm_info is None:
        return None
    return (
        vm_info,
        snapshot.compiled_firewalls.get(client_ip),
        snapshot.compiled_network_policies[client_ip],
    )
