"""Shared firewall test helpers."""

import asyncio

import matching


def wrap_firewalls(apis, name="test"):
    """Wrap a list of API entries into a firewall entry list."""
    return [{"name": name, "apis": apis}]


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
