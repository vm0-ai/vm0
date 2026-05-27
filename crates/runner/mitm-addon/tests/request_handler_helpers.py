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
    vm_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    vm_info: dict[str, object] = {
        "runId": run_id,
        "billableFirewalls": billable_firewalls or [],
        "sandboxToken": sandbox_marker,
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "firewalls": [{"name": firewall_name, "apis": [api_entry]}],
    }
    if network_policy is not None:
        vm_info["networkPolicies"] = {firewall_name: network_policy}
    if include_encrypted_secrets:
        vm_info["encryptedSecrets"] = "iv:tag:data"
    if vm_fields is not None:
        vm_info.update(vm_fields)
    return vm_info


def _write_github_firewall_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    base: str = "https://api.github.com",
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
        ),
    )
