"""Registry VM firewall entry resolution."""

import copy
from dataclasses import dataclass

import builtin_base_url
import builtin_host_policy
from generated.builtin_firewalls import BUILTIN_FIREWALLS

BuiltinFirewallCoreCacheKey = tuple[str, int, tuple[tuple[str, str], ...], tuple[str, ...]]


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
        copied_apis.append(dict(api))

    firewall = dict(catalog_firewall)
    firewall["apis"] = copied_apis
    return firewall, copied_apis


def _resolution_error(error: Exception) -> FirewallEntryResolutionError:
    return FirewallEntryResolutionError(str(error))


def _resolve_builtin_firewall_entry(entry: dict) -> _ResolvedBuiltinFirewallEntry:
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        raise FirewallEntryResolutionError("builtin firewall entry name must be a non-empty string")

    catalog_firewall = BUILTIN_FIREWALLS.get(raw_name)
    if catalog_firewall is None:
        raise FirewallEntryResolutionError(f'unknown builtin firewall "{raw_name}"')

    firewall, raw_apis = _copy_builtin_firewall_shell(
        firewall_name=raw_name,
        catalog_firewall=catalog_firewall,
    )

    try:
        vars_map = builtin_base_url.base_url_vars_for_entry(entry)
    except (TypeError, ValueError) as e:
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
        except (TypeError, ValueError) as e:
            raise _resolution_error(e) from e
        api["base"] = resolved_base
        resolved_bases.append(resolved_base)

    return _ResolvedBuiltinFirewallEntry(
        firewall=firewall,
        cache_key=(
            raw_name,
            id(catalog_firewall),
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


def resolve_firewall_entries(vm: dict) -> ResolvedFirewallEntries:
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
            resolved_builtin = _resolve_builtin_firewall_entry(entry)
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
