"""Proxy registry loading and VM lookup cache."""

import copy
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from mitmproxy import ctx

import matching
from auth import evict_all_cache_keys, evict_stale_cache_keys
from generated.builtin_firewalls import BUILTIN_FIREWALLS

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
_RegistryCacheKey = tuple[str, int, int, int, int]
MAX_REGISTRY_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_BASE_URL_VAR_PATTERN = re.compile(r"\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


class _RegistryFormatError(ValueError):
    """Registry JSON decoded successfully but does not have the expected shape."""


class _FirewallEntryResolutionError(ValueError):
    """Execution firewall entries could not be expanded into runtime configs."""


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


def _string_record(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise _FirewallEntryResolutionError(f"{field_name} must be an object")

    result: dict[str, str] = {}
    for key, nested in value.items():
        if not isinstance(key, str) or not isinstance(nested, str):
            raise _FirewallEntryResolutionError(f"{field_name} must contain string values")
        result[key] = nested
    return result


def _base_url_vars_for_entry(entry: dict) -> dict[str, str]:
    if "baseUrlVars" in entry:
        return _string_record(entry["baseUrlVars"], "baseUrlVars")
    return {}


def _resolve_base_url_template(
    *,
    firewall_name: str,
    base: str,
    vars_map: dict[str, str],
) -> str:
    def replace_var(match: re.Match[str]) -> str:
        name = match.group(1)
        value = vars_map.get(name)
        if not value:
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{firewall_name}" base URL requires variable "{name}"'
            )
        return value

    resolved = _BASE_URL_VAR_PATTERN.sub(replace_var, base)
    if not matching.firewall_base_config_is_valid(resolved):
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" resolved base URL is invalid'
        )
    return resolved


def _resolve_builtin_firewall_entry(entry: dict) -> dict:
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        raise _FirewallEntryResolutionError(
            "builtin firewall entry name must be a non-empty string"
        )

    catalog_firewall = BUILTIN_FIREWALLS.get(raw_name)
    if catalog_firewall is None:
        raise _FirewallEntryResolutionError(f'unknown builtin firewall "{raw_name}"')

    firewall = copy.deepcopy(catalog_firewall)
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        raise _FirewallEntryResolutionError(f'builtin firewall "{raw_name}" apis must be a list')

    vars_map = _base_url_vars_for_entry(entry)
    for api in raw_apis:
        if not isinstance(api, dict):
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" api entries must be objects'
            )
        raw_base = api.get("base")
        if not isinstance(raw_base, str):
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" api base must be a string'
            )
        api["base"] = _resolve_base_url_template(
            firewall_name=raw_name,
            base=raw_base,
            vars_map=vars_map,
        )

    return firewall


def _assign_firewall_api_ids(firewalls: list[dict], run_id: str) -> None:
    index = 0
    for firewall in firewalls:
        raw_apis = firewall.get("apis")
        if not isinstance(raw_apis, list):
            continue
        for api in raw_apis:
            if not isinstance(api, dict):
                continue
            raw_id = api.get("id")
            if not isinstance(raw_id, str) or raw_id == "":
                api["id"] = f"{run_id}:{index}"
            index += 1


def _is_legacy_firewall_entry(entry: dict) -> bool:
    if "kind" in entry:
        return False
    return isinstance(entry.get("name"), str) and isinstance(entry.get("apis"), list)


def _resolve_firewall_entries(vm: dict) -> list[dict] | None:
    raw_firewalls = vm.get("firewalls")
    if raw_firewalls is None:
        return None
    if not isinstance(raw_firewalls, list):
        raise _FirewallEntryResolutionError("firewalls must be a list")

    resolved: list[dict] = []
    for entry in raw_firewalls:
        if not isinstance(entry, dict):
            raise _FirewallEntryResolutionError("firewall entries must be objects")

        kind = entry.get("kind")
        if kind == "builtin":
            resolved.append(_resolve_builtin_firewall_entry(entry))
            continue
        if kind == "inline":
            firewall = entry.get("firewall")
            if not isinstance(firewall, dict):
                raise _FirewallEntryResolutionError(
                    "inline firewall entry firewall must be an object"
                )
            resolved.append(copy.deepcopy(firewall))
            continue
        if _is_legacy_firewall_entry(entry):
            resolved.append(copy.deepcopy(entry))
            continue

        raise _FirewallEntryResolutionError("firewall entries must use a supported kind")

    _assign_firewall_api_ids(resolved, vm["runId"])
    return resolved


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

        try:
            resolved_firewalls = _resolve_firewall_entries(vm)
        except _FirewallEntryResolutionError as e:
            invalid_vms[client_ip] = InvalidVmEntry("invalid_firewalls", str(e))
            continue

        vm = dict(vm)
        if resolved_firewalls is not None:
            vm["firewalls"] = resolved_firewalls

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
        except (ValueError, RecursionError) as e:
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
