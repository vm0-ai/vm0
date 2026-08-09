"""Shared request-handler registry helpers."""

import json
from pathlib import Path


def _write_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    vm_info: dict[str, object],
) -> Path:
    path = tmp_path / "registry.json"
    path.write_text(json.dumps({"vms": {client_ip: vm_info}}))
    return path


def _single_firewall_vm(
    tmp_path: Path,
    *,
    run_id: str = "run-conn-1",
    sandbox_marker: str = "tok-conn",
    firewall_name: str = "github",
    api_entry: dict[str, object],
    network_policy: dict[str, object] | None,
    billable_firewalls: list[str] | None = None,
    include_encrypted_secrets: bool = True,
    custom_connector_id: str | None = None,
    vm_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    firewall_entry: dict[str, object] = {
        "kind": "inline",
        "firewall": {"name": firewall_name, "apis": [api_entry]},
    }
    if custom_connector_id is not None:
        firewall_entry["customConnectorId"] = custom_connector_id
    vm_info: dict[str, object] = {
        "runId": run_id,
        "billableFirewalls": billable_firewalls or [],
        "sandboxToken": sandbox_marker,
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "firewalls": [firewall_entry],
    }
    if network_policy is not None:
        vm_info["networkPolicies"] = {firewall_name: network_policy}
    if custom_connector_id is not None:
        vm_info["connectorRoutingVariables"] = {f"custom:{custom_connector_id}": {}}
    if include_encrypted_secrets:
        vm_info["encryptedSecrets"] = "iv:tag:data"
    if vm_fields is not None:
        vm_info.update(vm_fields)
    return vm_info


def _shared_route_vm(tmp_path: Path, *, reverse: bool = False) -> dict[str, object]:
    """Build two credential owners for the same exact route."""

    def firewall(name: str, token: str, permission: str) -> dict[str, object]:
        return {
            "kind": "inline",
            "firewall": {
                "name": name,
                "apis": [
                    {
                        "base": "https://shared.example.com",
                        "auth": {
                            "headers": {"Authorization": f"Bearer ${{{{ secrets.{token} }}}}"}
                        },
                        "permissions": [
                            {
                                "name": permission,
                                "rules": ["GET /items/{id}"],
                            }
                        ],
                    }
                ],
            },
        }

    firewalls = [
        firewall("primary", "PRIMARY_TOKEN", "items-read"),
        firewall("auditor", "AUDITOR_TOKEN", "audit-read"),
    ]
    if reverse:
        firewalls.reverse()
    return {
        "runId": "run-shared-route",
        "sandboxToken": "tok-shared-route",
        "encryptedSecrets": "iv:tag:data",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "captureNetworkBodies": True,
        "firewalls": firewalls,
        "networkPolicies": {
            "primary": {
                "allow": ["items-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            "auditor": {
                "allow": ["audit-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        },
    }


def _vm_without_firewalls(
    tmp_path: Path,
    *,
    run_id: str = "run-conn-1",
    sandbox_marker: str = "tok-conn",
    vm_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    vm_info: dict[str, object] = {
        "runId": run_id,
        "sandboxToken": sandbox_marker,
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
    }
    if vm_fields is not None:
        vm_info.update(vm_fields)
    return vm_info


def _write_github_firewall_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    base: str = "https://api.github.com",
    vm_fields: dict[str, object] | None = None,
) -> Path:
    return _write_registry(
        tmp_path,
        client_ip=client_ip,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            vm_fields=vm_fields,
        ),
    )
