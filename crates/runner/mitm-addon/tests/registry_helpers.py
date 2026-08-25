"""Helpers for registry-focused mitm-addon tests."""

import json
import os
from pathlib import Path

import registry

_FIXED_MTIME_NS = 1_700_000_000_000_000_000


def assert_invalid_builtin_sandbox(registry_path: Path) -> registry.InvalidSandboxEntry:
    context = registry.get_sandbox_context("10.200.0.1", str(registry_path))
    state = registry.load_registry_state(str(registry_path))

    assert context is None
    assert not isinstance(state, registry.RegistryUnavailable)
    invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
    assert invalid_sandbox.reason == "invalid_firewalls"
    return invalid_sandbox


def write_trusted_catalog_cache_text(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o600)


def write_simple_registry(path, *, run_id="run-one"):
    data = {
        "sandboxes": {
            "10.200.0.1": {
                "runId": run_id,
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
            }
        },
        "updatedAt": 0,
    }
    path.write_text(json.dumps(data, sort_keys=True))


def pin_mtime(path):
    os.utime(path, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))


def write_firewall_registry(path, *, rule="/items"):
    data = {
        "sandboxes": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
                "firewalls": [
                    {
                        "kind": "inline",
                        "firewall": {
                            "name": "example",
                            "apis": [
                                {
                                    "base": "https://api.example.com",
                                    "auth": {"headers": {"Authorization": "Bearer token"}},
                                    "permissions": [
                                        {"name": "read", "rules": [f"GET {rule}"]},
                                    ],
                                }
                            ],
                        },
                    }
                ],
                "networkPolicies": {
                    "example": {
                        "allow": ["read"],
                        "deny": [],
                        "unknownPolicy": "deny",
                    }
                },
            }
        },
        "updatedAt": 1700000000000,
    }
    path.write_text(json.dumps(data))


def write_builtin_firewall_registry(
    path,
    *,
    run_id: str,
    name: str,
    base_url_vars: dict[str, str],
) -> None:
    path.write_text(
        json.dumps(
            {
                "sandboxes": {
                    "10.200.0.1": {
                        "runId": run_id,
                        "billableFirewalls": [],
                        "cliAgentType": "claude-code",
                        "firewalls": [
                            {
                                "kind": "builtin",
                                "name": name,
                                "baseUrlVars": base_url_vars,
                            }
                        ],
                    }
                },
                "updatedAt": 0,
            }
        )
    )


def write_multi_sandbox_registry(path, sandboxes: dict) -> None:
    path.write_text(json.dumps({"sandboxes": sandboxes, "updatedAt": 0}))


def builtin_sandbox(run_id: str, name: str, base_url_vars: dict[str, str] | None = None) -> dict:
    entry: dict[str, object] = {"kind": "builtin", "name": name}
    if base_url_vars is not None:
        entry["baseUrlVars"] = base_url_vars
    return {
        "runId": run_id,
        "billableFirewalls": [],
        "cliAgentType": "claude-code",
        "firewalls": [entry],
    }


def inline_sandbox(run_id: str) -> dict:
    return {
        "runId": run_id,
        "billableFirewalls": [],
        "cliAgentType": "claude-code",
        "firewalls": [
            {
                "kind": "inline",
                "firewall": {
                    "name": "example",
                    "apis": [
                        {
                            "base": "https://api.example.com",
                            "auth": {"headers": {"Authorization": "Bearer token"}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
            }
        ],
    }
