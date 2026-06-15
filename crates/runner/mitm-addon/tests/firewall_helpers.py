"""Shared firewall test helpers."""

import asyncio

import matching

DEFAULT_AUTH = object()


def wrap_firewalls(apis, name="test"):
    """Wrap a list of API entries into a firewall entry list."""
    return [{"name": name, "apis": apis}]


def firewall_permission(name, *rules):
    return {"name": name, "rules": list(rules)}


def firewall_api(base, permissions, *, auth=DEFAULT_AUTH, auth_label="token"):
    api_auth = (
        {"headers": {"Authorization": f"Bearer {auth_label}"}} if auth is DEFAULT_AUTH else auth
    )
    return {
        "base": base,
        "auth": api_auth,
        "permissions": list(permissions),
    }


def firewall_entry(name, *apis):
    return {"name": name, "apis": list(apis)}


def network_policy(*, allow=(), deny=(), ask=(), unknown_policy="deny"):
    result = {
        "allow": list(allow),
        "deny": list(deny),
        "unknownPolicy": unknown_policy,
    }
    if ask:
        result["ask"] = list(ask)
    return result


def grant_all(firewalls, unknown_policy="deny"):
    """Build networkPolicies that grants all permissions for each firewall."""
    result = {}
    for fw in firewalls or []:
        perms = set()
        for api in fw.get("apis", []):
            for perm in api.get("permissions", []):
                perms.add(perm["name"])
        result[fw["name"]] = {
            "allow": list(perms),
            "deny": [],
            "ask": [],
            "unknownPolicy": unknown_policy,
        }
    return result


def compile_firewalls_or_fail(firewalls):
    compiled = matching.compile_firewalls(firewalls)
    assert compiled is not None
    return compiled


def match_compiled_firewalls(url, firewalls, network_policies, *, method="GET"):
    return matching.match_compiled_firewall_request(
        url,
        method,
        compile_firewalls_or_fail(firewalls),
        network_policies,
    )


def match_request_with_raw_firewalls(url, method, firewalls, network_policies=None):
    """Match raw firewall config through the production compiled matcher."""
    compiled_firewalls = matching.compile_firewalls(firewalls)
    return matching.match_compiled_firewall_request(
        url,
        method,
        compiled_firewalls,
        network_policies,
    )


async def cancel_pending_task(task: asyncio.Task | None) -> None:
    if task is None or task.done():
        return
    task.cancel()
    _ = await asyncio.gather(task, return_exceptions=True)
