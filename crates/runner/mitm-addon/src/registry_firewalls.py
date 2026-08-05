"""Registry VM firewall entry resolution."""

import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Literal, NamedTuple

import builtin_base_url
import builtin_firewall_cache
import builtin_host_policy

BuiltinFirewallCatalogFileKey = builtin_firewall_cache.CatalogFileKey
BuiltinFirewallCatalogIdentity = builtin_firewall_cache.CatalogIdentity
BuiltinFirewallCatalogSnapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot


class BuiltinFirewallAdmissionIdentity(NamedTuple):
    source: Literal["admission"]
    firewall_digest: str


BuiltinFirewallSourceIdentity = BuiltinFirewallCatalogIdentity | BuiltinFirewallAdmissionIdentity
BuiltinFirewallCoreCacheKey = tuple[
    str,
    BuiltinFirewallSourceIdentity,
    tuple[tuple[str, str], ...],
    tuple[str, ...],
]


class FirewallEntryResolutionError(ValueError):
    """Execution firewall entries could not be expanded into runtime configs."""


@dataclass(frozen=True)
class ResolvedFirewallEntries:
    """Resolved registry firewall configs and aligned builtin cache keys.

    `firewalls` contains the runtime firewall configs that registry state should
    use after builtin and inline expansion. `firewalls is None` preserves a VM
    that did not provide a `firewalls` entry at all.

    When firewalls are present, `builtin_cache_keys` is positionally aligned
    with them: `builtin_cache_keys[i]` describes `firewalls[i]`. A per-entry
    cache key of `None` means that firewall came from an inline entry and must
    bypass builtin compiled-core cache reuse.
    """

    firewalls: list[dict] | None
    builtin_cache_keys: tuple[BuiltinFirewallCoreCacheKey | None, ...] | None
    unavailable_names: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        if self.firewalls is None:
            if self.builtin_cache_keys is not None:
                raise ValueError("builtin cache keys must be absent when firewalls are absent")
            if self.unavailable_names:
                raise ValueError("unavailable names must be absent when firewalls are absent")
            return
        if self.builtin_cache_keys is None:
            raise ValueError("builtin cache keys must be present when firewalls are present")
        if len(self.firewalls) != len(self.builtin_cache_keys):
            raise ValueError("builtin cache keys must align with resolved firewalls")


@dataclass(frozen=True)
class _ResolvedBuiltinFirewallEntry:
    firewall: dict
    cache_key: BuiltinFirewallCoreCacheKey
    unavailable: bool


def reset_cache_for_tests() -> None:
    """Reset builtin firewall resolver cache state between tests."""
    clear_catalog_cache()


def clear_catalog_cache() -> None:
    """Drop the cached builtin firewall catalog snapshot."""
    builtin_firewall_cache.clear_cache()


def configured_catalog_cache_path() -> str | None:
    """Return the runner-configured builtin catalog cache path."""
    return builtin_firewall_cache.configured_catalog_cache_path()


def catalog_file_key(
    cache_path: str | None,
) -> builtin_firewall_cache.CatalogFileKey | None:
    """Return the registry-facing builtin catalog cache identity."""
    return builtin_firewall_cache.catalog_file_key(cache_path)


def load_catalog_snapshot(cache_path: str | None) -> BuiltinFirewallCatalogSnapshot:
    """Load the registry-facing builtin catalog snapshot for one resolver pass."""
    return builtin_firewall_cache.load_catalog_snapshot(cache_path)


def _copy_builtin_firewall_shell(
    *,
    firewall_name: str,
    catalog_firewall: dict,
) -> tuple[dict, list[dict]]:
    raw_apis = catalog_firewall.get("apis")
    if not isinstance(raw_apis, list):
        raise FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" apis must be a list'
        )

    copied_apis: list[dict] = []
    for api in raw_apis:
        if not isinstance(api, dict):
            raise FirewallEntryResolutionError(
                f'builtin firewall "{firewall_name}" api entries must be objects'
            )
        copied_api = dict(api)
        copied_api.pop("id", None)
        copied_api.pop(builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER, None)
        copied_apis.append(copied_api)

    firewall = dict(catalog_firewall)
    firewall["apis"] = copied_apis
    return firewall, copied_apis


def _resolution_error(error: Exception) -> FirewallEntryResolutionError:
    return FirewallEntryResolutionError(str(error))


def _catalog_source_for_name(
    raw_name: str,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
    vm: dict,
) -> tuple[dict, BuiltinFirewallSourceIdentity, bool]:
    cached_catalog = catalog_snapshot.catalog
    if cached_catalog is None:
        reason = catalog_snapshot.unavailable_reason or "cache_unavailable"
        if catalog_snapshot.cache_path is None:
            raise FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" catalog cache unavailable: {reason}'
            )
        raise FirewallEntryResolutionError(
            f'builtin firewall "{raw_name}" catalog cache unavailable: '
            f"{reason} ({catalog_snapshot.cache_path})"
        )
    catalog_firewall = cached_catalog.firewalls.get(raw_name)
    if catalog_firewall is not None:
        return catalog_firewall, cached_catalog.identity, False

    admissions = vm.get("builtinFirewallAdmissions")
    if not isinstance(admissions, dict):
        raise FirewallEntryResolutionError(
            f'builtin firewall "{raw_name}" missing from catalog cache '
            f"(catalog_digest={cached_catalog.identity.catalog_digest}, "
            f"catalog_version={cached_catalog.identity.catalog_version})"
        )
    admission_firewall = admissions.get(raw_name)
    if not isinstance(admission_firewall, dict):
        raise FirewallEntryResolutionError(
            f'builtin firewall "{raw_name}" missing a valid VM admission snapshot'
        )
    try:
        builtin_firewall_cache.validate_firewall(raw_name, admission_firewall)
    except builtin_firewall_cache.BuiltinFirewallCatalogCacheError as e:
        raise FirewallEntryResolutionError(
            f'builtin firewall "{raw_name}" VM admission snapshot is invalid: {e}'
        ) from e
    canonical_firewall = json.dumps(
        admission_firewall,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    admission_identity = BuiltinFirewallAdmissionIdentity(
        source="admission",
        firewall_digest=f"sha256:{hashlib.sha256(canonical_firewall).hexdigest()}",
    )
    return admission_firewall, admission_identity, True


def _resolve_builtin_firewall_entry(
    entry: dict,
    *,
    vm: dict,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
) -> _ResolvedBuiltinFirewallEntry:
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        raise FirewallEntryResolutionError("builtin firewall entry name must be a non-empty string")

    catalog_firewall, source_identity, unavailable = _catalog_source_for_name(
        raw_name,
        catalog_snapshot,
        vm,
    )

    firewall, raw_apis = _copy_builtin_firewall_shell(
        firewall_name=raw_name,
        catalog_firewall=catalog_firewall,
    )

    try:
        vars_map = builtin_base_url.base_url_vars_for_entry(entry)
    except builtin_base_url.BuiltinBaseUrlResolutionError as e:
        raise _resolution_error(e) from e

    resolved_bases: list[str] = []
    for api in raw_apis:
        raw_base = api.get("base")
        if not isinstance(raw_base, str):
            raise FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" api base must be a string'
            )
        try:
            resolved_base = builtin_base_url.resolve_base_url_template(
                firewall_name=raw_name,
                base=raw_base,
                vars_map=vars_map,
            )
            compiled_host_policy = builtin_host_policy.validate_credentialed_builtin_base(
                firewall_name=raw_name,
                base=resolved_base,
                auth_config=api.get("auth"),
                host_policy=api.get("hostPolicy"),
            )
        except (
            builtin_base_url.BuiltinBaseUrlResolutionError,
            builtin_host_policy.BuiltinHostPolicyError,
        ) as e:
            raise _resolution_error(e) from e
        api["base"] = resolved_base
        if api.get("hostPolicy") is not None:
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] = (
                compiled_host_policy if compiled_host_policy is not None else True
            )
        resolved_bases.append(resolved_base)

    return _ResolvedBuiltinFirewallEntry(
        firewall=firewall,
        cache_key=(
            raw_name,
            source_identity,
            tuple(sorted(vars_map.items())),
            tuple(resolved_bases),
        ),
        unavailable=unavailable,
    )


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


def resolve_firewall_entries(
    vm: dict,
    *,
    builtin_firewall_catalog_cache_path: str | None = None,
    builtin_firewall_catalog_snapshot: BuiltinFirewallCatalogSnapshot | None = None,
) -> ResolvedFirewallEntries:
    """Expand a registry VM's firewall entries into runtime firewall configs.

    Supported entry kinds are `builtin` and `inline`. Builtins resolve from the
    supplied catalog snapshot when provided, otherwise from the catalog cache
    path. A supplied snapshot pins builtin resolution for this call so a single
    registry pass cannot mix catalog versions.

    Inline firewalls are deep-copied and receive per-entry `None` builtin cache
    keys. Builtin catalog API IDs are discarded during expansion, so builtin
    APIs receive generated run-scoped IDs. Inline APIs preserve an existing
    non-empty string ID; absent, empty, or non-string IDs are generated.
    Generated IDs use `<runId>:<index>`, where the zero-based index advances over
    dictionary API entries in resolved firewall order, including entries whose
    IDs are preserved. Callers must validate `vm["runId"]` as a non-empty string
    before calling.

    Raises `FirewallEntryResolutionError` for malformed firewall lists or
    entries, unsupported entry kinds, unknown builtins, invalid builtin base URL
    templates, and builtin host-policy validation failures.
    """
    raw_firewalls = vm.get("firewalls")
    if raw_firewalls is None:
        return ResolvedFirewallEntries(None, None, frozenset())
    if not isinstance(raw_firewalls, list):
        raise FirewallEntryResolutionError("firewalls must be a list")

    resolved: list[dict] = []
    builtin_cache_keys: list[BuiltinFirewallCoreCacheKey | None] = []
    unavailable_names: set[str] = set()
    for entry in raw_firewalls:
        if not isinstance(entry, dict):
            raise FirewallEntryResolutionError("firewall entries must be objects")

        kind = entry.get("kind")
        if kind == "builtin":
            if builtin_firewall_catalog_snapshot is None:
                builtin_firewall_catalog_snapshot = load_catalog_snapshot(
                    builtin_firewall_catalog_cache_path
                )
            resolved_builtin = _resolve_builtin_firewall_entry(
                entry,
                vm=vm,
                catalog_snapshot=builtin_firewall_catalog_snapshot,
            )
            resolved.append(resolved_builtin.firewall)
            builtin_cache_keys.append(resolved_builtin.cache_key)
            if resolved_builtin.unavailable:
                unavailable_names.add(resolved_builtin.firewall["name"])
            continue
        if kind == "inline":
            firewall = entry.get("firewall")
            if not isinstance(firewall, dict):
                raise FirewallEntryResolutionError(
                    "inline firewall entry firewall must be an object"
                )
            resolved.append(copy.deepcopy(firewall))
            builtin_cache_keys.append(None)
            continue
        raise FirewallEntryResolutionError("firewall entries must use a supported kind")

    _assign_firewall_api_ids(resolved, vm["runId"])
    return ResolvedFirewallEntries(
        resolved,
        tuple(builtin_cache_keys),
        frozenset(unavailable_names),
    )
