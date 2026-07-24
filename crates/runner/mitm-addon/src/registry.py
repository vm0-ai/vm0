"""Proxy registry loading and VM lookup cache."""

import json
import os
import stat
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from mitmproxy import ctx

import matching
import registry_firewalls
from firewall_auth_cache import evict_all_cache_keys, evict_stale_cache_keys

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
type _RegistryFileKey = tuple[
    str,
    int,
    int,
    int,
    int,
]
MAX_REGISTRY_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024


class _RegistryFormatError(ValueError):
    """Registry JSON decoded successfully but does not have the expected shape."""


@dataclass(frozen=True)
class InvalidVmEntry:
    """Registry entry present for an IP but invalid for runtime VM context use."""

    reason: str
    message: str


@dataclass(frozen=True)
class _RegistrySnapshot:
    vms: dict
    invalid_vms: dict[str, InvalidVmEntry]
    compiled_firewalls: dict[str, matching.CompiledFirewallSet]
    compiled_network_policies: dict[str, matching.CompiledNetworkPolicies]
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    loaded_key: _RegistryFileKey | None


@dataclass(frozen=True)
class RegistryUnavailable:
    """Current registry file cannot be trusted as an enforcement source."""

    reason: str
    message: str


RegistryState = _RegistrySnapshot | RegistryUnavailable


def _empty_snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot({}, {}, {}, {}, None, None)


@dataclass
class _RegistryCacheState:
    registry_path: str | None = None
    # Successful registry state is stored in one snapshot so raw VM entries and
    # compiled matcher sidecars are published together.
    snapshot: _RegistrySnapshot = field(default_factory=_empty_snapshot)
    unavailable: RegistryUnavailable | None = None
    # Known-bad decoded registry input. This key should short-circuit until the
    # file changes again, while enforcement continues to see RegistryUnavailable.
    failed_key: _RegistryFileKey | None = None
    # Open/stat failures do not provide a key, so use a one-shot guard. Read
    # errors have a key but are retried on every call; track their last warning
    # key only to avoid request-path log spam without poisoning the file state.
    stat_error_logged: bool = False
    read_error_key: _RegistryFileKey | None = None
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ] = field(default_factory=dict)

    def reset(self, registry_path: str | None = None) -> None:
        self.registry_path = registry_path
        self.snapshot = _empty_snapshot()
        self.unavailable = None
        self.failed_key = None
        self.stat_error_logged = False
        self.read_error_key = None
        self.builtin_firewall_core_cache = {}


_registry_state = _RegistryCacheState()


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    _registry_state.reset()
    registry_firewalls.reset_cache_for_tests()


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _RegistryCacheState:
    if _registry_state.registry_path != path_key:
        if _registry_state.snapshot.loaded_key is not None:
            evict_all_cache_keys()
        _registry_state.reset(path_key)
    return _registry_state


def _compile_registry(
    new_registry: dict,
    builtin_cache_keys: dict[
        str,
        tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...],
    ],
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> tuple[
    dict[str, matching.CompiledFirewallSet],
    dict[str, matching.CompiledNetworkPolicies],
]:
    compiled_firewall_registry: dict[str, matching.CompiledFirewallSet] = {}
    compiled_policy_registry: dict[str, matching.CompiledNetworkPolicies] = {}
    for client_ip, vm in new_registry.items():
        firewalls = vm.get("firewalls")
        compiled_firewalls = _compile_firewalls_with_builtin_cache(
            firewalls,
            builtin_cache_keys.get(client_ip),
            builtin_firewall_core_cache,
        )
        if compiled_firewalls is not None:
            compiled_firewall_registry[client_ip] = compiled_firewalls
        network_policies = vm.get("networkPolicies")
        compiled_policy_registry[client_ip] = matching.compile_network_policies(network_policies)
    _prune_builtin_firewall_core_cache(builtin_firewall_core_cache, builtin_cache_keys.values())
    return compiled_firewall_registry, compiled_policy_registry


def _prune_builtin_firewall_core_cache(
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
    active_key_groups: Iterable[tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...]],
) -> None:
    active_keys = {
        cache_key
        for cache_keys in active_key_groups
        for cache_key in cache_keys
        if cache_key is not None
    }
    stale_keys = set(builtin_firewall_core_cache) - active_keys
    for cache_key in stale_keys:
        del builtin_firewall_core_cache[cache_key]


def _compile_firewalls_with_builtin_cache(
    firewalls: object | None,
    builtin_cache_keys: tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...] | None,
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> matching.CompiledFirewallSet | None:
    if not isinstance(firewalls, list) or not firewalls:
        return None
    if builtin_cache_keys is None or len(builtin_cache_keys) != len(firewalls):
        return matching.compile_firewalls(firewalls)

    compiled_firewalls = []
    for firewall, cache_key in zip(firewalls, builtin_cache_keys, strict=False):
        if not isinstance(firewall, dict):
            continue
        if cache_key is None:
            inline_compiled = matching.compile_firewalls([firewall])
            if inline_compiled is not None:
                compiled_firewalls.extend(inline_compiled.firewalls)
            continue

        compiled_core = builtin_firewall_core_cache.get(cache_key)
        if compiled_core is None:
            compiled_core = matching.compile_firewall_core(firewall)
            if compiled_core is None:
                continue
            builtin_firewall_core_cache[cache_key] = compiled_core
        compiled_firewall = matching.bind_compiled_firewall_core(firewall, compiled_core)
        if compiled_firewall is not None:
            compiled_firewalls.append(compiled_firewall)

    if not compiled_firewalls:
        return None
    return matching.CompiledFirewallSet(tuple(compiled_firewalls))


def _builtin_firewall_catalog_cache_path() -> str | None:
    return registry_firewalls.configured_catalog_cache_path()


def _classify_registry_vms(
    raw_registry: dict,
    *,
    builtin_firewall_catalog_cache_path: str | None,
) -> tuple[
    dict,
    dict[str, InvalidVmEntry],
    dict[str, tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...]],
    registry_firewalls.BuiltinFirewallCatalogSnapshot | None,
]:
    new_registry: dict = {}
    invalid_vms: dict[str, InvalidVmEntry] = {}
    builtin_cache_keys_by_client_ip: dict[
        str,
        tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...],
    ] = {}
    builtin_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None = None
    for client_ip, vm in raw_registry.items():
        if not isinstance(vm, dict):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_vm_entry",
                "proxy registry VM entry must be an object",
            )
            continue

        if "runId" not in vm:
            invalid_vms[client_ip] = InvalidVmEntry(
                "missing_run_id",
                "proxy registry VM entry is missing runId",
            )
            continue

        run_id = vm["runId"]
        if not isinstance(run_id, str):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_run_id",
                "proxy registry VM entry runId must be a string",
            )
            continue
        if not run_id.strip():
            invalid_vms[client_ip] = InvalidVmEntry(
                "empty_run_id",
                "proxy registry VM entry runId must be non-empty",
            )
            continue
        if run_id != run_id.strip():
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_run_id",
                "proxy registry VM entry runId must not include leading or trailing whitespace",
            )
            continue

        if (
            "firewalls" in vm
            and vm["firewalls"] is not None
            and not isinstance(vm["firewalls"], list)
        ):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_firewalls",
                "proxy registry VM entry firewalls must be a list",
            )
            continue

        raw_firewalls = vm.get("firewalls")
        vm_uses_builtin_catalog_dependency = isinstance(raw_firewalls, list) and any(
            isinstance(entry, dict) and entry.get("kind") == "builtin" for entry in raw_firewalls
        )
        if vm_uses_builtin_catalog_dependency and builtin_catalog_snapshot is None:
            builtin_catalog_snapshot = registry_firewalls.load_catalog_snapshot(
                builtin_firewall_catalog_cache_path
            )

        try:
            resolved_firewalls = registry_firewalls.resolve_firewall_entries(
                vm,
                builtin_firewall_catalog_cache_path=builtin_firewall_catalog_cache_path,
                builtin_firewall_catalog_snapshot=builtin_catalog_snapshot,
            )
        except registry_firewalls.FirewallEntryResolutionError as e:
            invalid_vms[client_ip] = InvalidVmEntry("invalid_firewalls", str(e))
            continue

        vm = dict(vm)
        if resolved_firewalls.firewalls is not None:
            vm["firewalls"] = resolved_firewalls.firewalls
            if resolved_firewalls.builtin_cache_keys is not None:
                builtin_cache_keys_by_client_ip[client_ip] = resolved_firewalls.builtin_cache_keys

        new_registry[client_ip] = vm

    return (
        new_registry,
        invalid_vms,
        builtin_cache_keys_by_client_ip,
        builtin_catalog_snapshot,
    )


def _open_registry_for_read(path: Path) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise OSError(f"proxy registry is not a regular file: {path}")
    return fd, st


def _read_registry_bytes(fd: int, path: Path, st_size: int) -> bytes:
    if st_size > MAX_REGISTRY_BYTES:
        raise OSError(f"proxy registry {path} exceeds {MAX_REGISTRY_BYTES} bytes")

    chunks: list[bytes] = []
    total = 0
    while total <= MAX_REGISTRY_BYTES:
        to_read = min(_READ_CHUNK_BYTES, MAX_REGISTRY_BYTES + 1 - total)
        chunk = os.read(fd, to_read)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)

    if total > MAX_REGISTRY_BYTES:
        raise OSError(f"proxy registry {path} exceeds {MAX_REGISTRY_BYTES} bytes")
    return b"".join(chunks)


def _read_registry_vms(fd: int, path: Path, st_size: int) -> dict:
    raw_registry = json.loads(_read_registry_bytes(fd, path, st_size).decode("utf-8"))
    if not isinstance(raw_registry, dict):
        raise _RegistryFormatError("proxy registry must be an object")
    raw_vms = raw_registry.get("vms", {})
    if not isinstance(raw_vms, dict):
        raise _RegistryFormatError("proxy registry vms must be an object")
    return raw_vms


def _mark_unavailable(
    state: _RegistryCacheState,
    *,
    reason: str,
    message: str,
) -> RegistryUnavailable:
    if state.unavailable is None and state.snapshot.loaded_key is not None:
        evict_all_cache_keys()
    state.snapshot = _empty_snapshot()
    state.builtin_firewall_core_cache.clear()
    state.unavailable = RegistryUnavailable(reason, message)
    return state.unavailable


def load_registry_state(registry_path: str) -> RegistryState:
    """Load the proxy registry state, reusing cached data when possible.

    Cache state is scoped to one active registry path. A successful load
    publishes raw and compiled registry state together in a snapshot keyed by
    file identity metadata. Registry file open/stat/read/parse failures publish a
    separate unavailable state instead of returning a stale snapshot for
    enforcement. Malformed registry document input is recorded separately as a
    failed key so repeated reads of the same bad bytes do not reparse or
    re-warn. File read errors keep retrying that key, and internal
    compile/eviction errors are allowed to propagate.
    """
    path = Path(registry_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)
    builtin_catalog_cache_path = _builtin_firewall_catalog_cache_path()

    try:
        fd, st = _open_registry_for_read(path)
    except OSError as e:
        message = str(e)
        if not state.stat_error_logged:
            state.stat_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {message}")
        return _mark_unavailable(state, reason="stat_failed", message=message)

    try:
        key = (
            path_key,
            st.st_dev,
            st.st_ino,
            st.st_mtime_ns,
            st.st_size,
        )
        loaded_catalog_snapshot = state.snapshot.builtin_firewall_catalog_snapshot
        if key == state.snapshot.loaded_key and (
            loaded_catalog_snapshot is None
            or registry_firewalls.catalog_file_key(builtin_catalog_cache_path)
            == loaded_catalog_snapshot.dependency_file_key
        ):
            state.unavailable = None
            state.stat_error_logged = False
            state.read_error_key = None
            return state.snapshot
        if key == state.failed_key:
            return state.unavailable or _mark_unavailable(
                state,
                reason="parse_failed",
                message="proxy registry is unavailable",
            )

        try:
            raw_registry = _read_registry_vms(fd, path, st.st_size)
        except OSError as e:
            message = str(e)
            state.failed_key = None
            if key != state.read_error_key:
                state.read_error_key = key
                ctx.log.warn(f"Failed to read proxy registry: {message}")
            return _mark_unavailable(state, reason="read_failed", message=message)
        except (ValueError, RecursionError) as e:
            message = str(e)
            state.failed_key = key
            state.read_error_key = None
            ctx.log.warn(f"Failed to parse proxy registry: {message}")
            return _mark_unavailable(state, reason="parse_failed", message=message)
    finally:
        os.close(fd)

    (
        new_registry,
        invalid_vms,
        builtin_cache_keys,
        builtin_catalog_snapshot,
    ) = _classify_registry_vms(
        raw_registry,
        builtin_firewall_catalog_cache_path=builtin_catalog_cache_path,
    )
    if invalid_vms:
        ctx.log.warn(f"Rejected {len(invalid_vms)} invalid proxy registry VM entries")
    new_compiled_registry, new_compiled_policy_registry = _compile_registry(
        new_registry,
        builtin_cache_keys,
        state.builtin_firewall_core_cache,
    )

    # Evict cache entries for runs no longer in the registry.
    active_run_ids = {vm["runId"] for vm in new_registry.values()}
    evict_stale_cache_keys(active_run_ids)

    state.snapshot = _RegistrySnapshot(
        new_registry,
        invalid_vms,
        new_compiled_registry,
        new_compiled_policy_registry,
        builtin_catalog_snapshot,
        key,
    )
    state.unavailable = None
    state.failed_key = None
    state.stat_error_logged = False
    state.read_error_key = None
    return state.snapshot


def load_registry(registry_path: str) -> dict:
    """Load a lossy compatibility view containing only usable VM entries.

    Invalid entries are omitted. An empty mapping can mean either that a
    successfully loaded registry has no usable entries or that the registry is
    unavailable after an open, stat, read, or parse failure. Use
    `load_registry_state()` when those states must be distinguished.
    """
    state = load_registry_state(registry_path)
    if isinstance(state, RegistryUnavailable):
        return {}
    return state.vms


def get_vm_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up VM info in the lossy compatibility view for a client IP.

    `None` can mean that the IP is absent, its registry entry is invalid, or the
    registry is unavailable. Use `load_registry_state()` when those states must
    be distinguished.
    """
    return load_registry(registry_path).get(client_ip)


def get_vm_context(
    client_ip: str,
    registry_path: str,
) -> VmContext | None:
    """Look up raw VM info with compiled matcher sidecars in a compatibility view.

    `None` can mean that the IP is absent, its registry entry is invalid, or the
    registry is unavailable. Use `load_registry_state()` when those states must
    be distinguished.
    """
    snapshot = load_registry_state(registry_path)
    if isinstance(snapshot, RegistryUnavailable):
        return None
    vm_info = snapshot.vms.get(client_ip)
    if vm_info is None:
        return None
    return (
        vm_info,
        snapshot.compiled_firewalls.get(client_ip),
        snapshot.compiled_network_policies[client_ip],
    )
