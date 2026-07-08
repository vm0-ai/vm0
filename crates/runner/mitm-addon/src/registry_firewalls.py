"""Registry VM firewall entry resolution."""

import copy
from contextlib import suppress
from dataclasses import dataclass

from mitmproxy import ctx

import builtin_base_url
import builtin_firewall_cache
import builtin_host_policy
from generated.builtin_firewalls import BUILTIN_FIREWALLS

BuiltinFirewallCatalogFileKey = builtin_firewall_cache.CatalogFileKey
BuiltinFirewallCatalogIdentity = builtin_firewall_cache.CatalogIdentity | tuple[str, str, str]
BuiltinFirewallCatalogSnapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot
BuiltinFirewallCoreCacheKey = tuple[
    str,
    BuiltinFirewallCatalogIdentity,
    tuple[tuple[str, str], ...],
    tuple[str, ...],
]


class FirewallEntryResolutionError(ValueError):
    """Execution firewall entries could not be expanded into runtime configs."""


@dataclass(frozen=True)
class ResolvedFirewallEntries:
    firewalls: list[dict] | None
    builtin_cache_keys: tuple[BuiltinFirewallCoreCacheKey | None, ...] | None


@dataclass(frozen=True)
class _ResolvedBuiltinFirewallEntry:
    firewall: dict
    cache_key: BuiltinFirewallCoreCacheKey


_bundled_fallback_warnings: set[
    tuple[
        str,
        str,
        str | None,
        BuiltinFirewallCatalogFileKey | None,
        str | None,
        str | None,
    ]
] = set()


def reset_cache_for_tests() -> None:
    """Reset builtin firewall resolver cache state between tests."""
    builtin_firewall_cache.reset_cache_for_tests()
    _bundled_fallback_warnings.clear()


def catalog_file_key(
    cache_path: str | None,
) -> builtin_firewall_cache.CatalogFileKey | None:
    return builtin_firewall_cache.catalog_file_key(cache_path)


def load_catalog_snapshot(cache_path: str | None) -> BuiltinFirewallCatalogSnapshot:
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
) -> tuple[dict | None, BuiltinFirewallCatalogIdentity]:
    cached_catalog = catalog_snapshot.catalog
    if cached_catalog is not None:
        catalog_firewall = cached_catalog.firewalls.get(raw_name)
        if catalog_firewall is not None:
            return catalog_firewall, cached_catalog.identity
        fallback_reason = "cache_missing_firewall"
    else:
        fallback_reason = catalog_snapshot.fallback_reason or "cache_unavailable"

    catalog_firewall = BUILTIN_FIREWALLS.get(raw_name)
    if catalog_firewall is not None:
        _warn_bundled_fallback(
            raw_name=raw_name,
            reason=fallback_reason,
            catalog_snapshot=catalog_snapshot,
        )
    return catalog_firewall, ("bundled", raw_name, str(id(catalog_firewall)))


def _warn_bundled_fallback(
    *,
    raw_name: str,
    reason: str,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
) -> None:
    cached_catalog = catalog_snapshot.catalog
    catalog_digest = None
    catalog_version = None
    if cached_catalog is not None:
        _, catalog_digest, catalog_version, _ = cached_catalog.identity
    warning_file_key = None if cached_catalog is not None else catalog_snapshot.dependency_file_key

    warning_key = (
        raw_name,
        reason,
        catalog_snapshot.cache_path,
        warning_file_key,
        catalog_digest,
        catalog_version,
    )
    if warning_key in _bundled_fallback_warnings:
        return
    _bundled_fallback_warnings.add(warning_key)

    fields = [
        "Using bundled builtin firewall fallback",
        f"reason={reason}",
        f"firewall_name={raw_name}",
    ]
    if catalog_snapshot.cache_path is not None:
        fields.append(f"cache_path={catalog_snapshot.cache_path}")
    if catalog_digest is not None:
        fields.append(f"catalog_digest={catalog_digest}")
    if catalog_version is not None:
        fields.append(f"catalog_version={catalog_version}")
    if warning_file_key is not None:
        fields.append(f"cache_file_key={warning_file_key!r}")

    with suppress(Exception):
        ctx.log.warn(" ".join(fields))


def _resolve_builtin_firewall_entry(
    entry: dict,
    *,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
) -> _ResolvedBuiltinFirewallEntry:
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        raise FirewallEntryResolutionError("builtin firewall entry name must be a non-empty string")

    catalog_firewall, catalog_identity = _catalog_source_for_name(raw_name, catalog_snapshot)
    if catalog_firewall is None:
        raise FirewallEntryResolutionError(f'unknown builtin firewall "{raw_name}"')

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
            builtin_host_policy.validate_credentialed_builtin_base(
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
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] = True
        resolved_bases.append(resolved_base)

    return _ResolvedBuiltinFirewallEntry(
        firewall=firewall,
        cache_key=(
            raw_name,
            catalog_identity,
            tuple(sorted(vars_map.items())),
            tuple(resolved_bases),
        ),
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
    raw_firewalls = vm.get("firewalls")
    if raw_firewalls is None:
        return ResolvedFirewallEntries(None, None)
    if not isinstance(raw_firewalls, list):
        raise FirewallEntryResolutionError("firewalls must be a list")

    resolved: list[dict] = []
    builtin_cache_keys: list[BuiltinFirewallCoreCacheKey | None] = []
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
                catalog_snapshot=builtin_firewall_catalog_snapshot,
            )
            resolved.append(resolved_builtin.firewall)
            builtin_cache_keys.append(resolved_builtin.cache_key)
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
    return ResolvedFirewallEntries(resolved, tuple(builtin_cache_keys))
