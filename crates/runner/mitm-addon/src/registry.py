"""Proxy registry loading and VM lookup cache."""

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path

from mitmproxy import ctx

import matching
from auth import evict_all_cache_keys, evict_stale_cache_keys

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
_RegistryCacheKey = tuple[str, int, int, int, int]
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
    loaded_key: _RegistryCacheKey | None


@dataclass(frozen=True)
class RegistryUnavailable:
    """Current registry file cannot be trusted as an enforcement source."""

    reason: str
    message: str


RegistryState = _RegistrySnapshot | RegistryUnavailable


def _empty_snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot({}, {}, {}, {}, None)


@dataclass
class _RegistryCacheState:
    registry_path: str | None = None
    # Successful registry state is stored in one snapshot so raw VM entries and
    # compiled matcher sidecars are published together.
    snapshot: _RegistrySnapshot = field(default_factory=_empty_snapshot)
    unavailable: RegistryUnavailable | None = None
    # Known-bad decoded registry input. Unlike the snapshot loaded key, this
    # means the current snapshot belongs to an older file state and this key
    # should short-circuit until the file changes again.
    failed_key: _RegistryCacheKey | None = None
    # Open/stat failures do not provide a key, so use a one-shot guard. Read
    # errors have a key but are retried on every call; track their last warning
    # key only to avoid request-path log spam without poisoning the file state.
    stat_error_logged: bool = False
    read_error_key: _RegistryCacheKey | None = None

    def reset(self, registry_path: str | None = None) -> None:
        self.registry_path = registry_path
        self.snapshot = _empty_snapshot()
        self.unavailable = None
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
        if _registry_state.snapshot.loaded_key is not None:
            evict_all_cache_keys()
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
        firewalls = vm.get("firewalls")
        compiled_firewalls = matching.compile_firewalls(firewalls)
        if compiled_firewalls is not None:
            compiled_firewall_registry[client_ip] = compiled_firewalls
        network_policies = vm.get("networkPolicies")
        compiled_policy_registry[client_ip] = matching.compile_network_policies(network_policies)
    return compiled_firewall_registry, compiled_policy_registry


def _classify_registry_vms(raw_registry: dict) -> tuple[dict, dict[str, InvalidVmEntry]]:
    new_registry: dict = {}
    invalid_vms: dict[str, InvalidVmEntry] = {}
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

        new_registry[client_ip] = vm

    return new_registry, invalid_vms


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

    try:
        fd, st = _open_registry_for_read(path)
    except OSError as e:
        message = str(e)
        if not state.stat_error_logged:
            state.stat_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {message}")
        return _mark_unavailable(state, reason="stat_failed", message=message)

    try:
        key = (path_key, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
        if key == state.snapshot.loaded_key:
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
        except (json.JSONDecodeError, UnicodeDecodeError, _RegistryFormatError) as e:
            message = str(e)
            state.failed_key = key
            state.read_error_key = None
            ctx.log.warn(f"Failed to parse proxy registry: {message}")
            return _mark_unavailable(state, reason="parse_failed", message=message)
    finally:
        os.close(fd)

    new_registry, invalid_vms = _classify_registry_vms(raw_registry)
    if invalid_vms:
        ctx.log.warn(f"Rejected {len(invalid_vms)} invalid proxy registry VM entries")
    new_compiled_registry, new_compiled_policy_registry = _compile_registry(new_registry)

    # Evict cache entries for runs no longer in the registry.
    active_run_ids = {vm["runId"] for vm in new_registry.values()}
    evict_stale_cache_keys(active_run_ids)

    state.snapshot = _RegistrySnapshot(
        new_registry,
        invalid_vms,
        new_compiled_registry,
        new_compiled_policy_registry,
        key,
    )
    state.unavailable = None
    state.failed_key = None
    state.stat_error_logged = False
    state.read_error_key = None
    return state.snapshot


def load_registry(registry_path: str) -> dict:
    """Load the proxy registry, reusing cached data when possible."""
    state = load_registry_state(registry_path)
    if isinstance(state, RegistryUnavailable):
        return {}
    return state.vms


def get_vm_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up VM info by client IP address."""
    return load_registry(registry_path).get(client_ip)


def get_vm_context(
    client_ip: str,
    registry_path: str,
) -> VmContext | None:
    """Look up raw VM info with compiled firewall and policy matcher sidecars."""
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
