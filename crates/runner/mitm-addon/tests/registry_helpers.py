"""Helpers for registry-focused mitm-addon tests."""

import json
import os

_FIXED_MTIME_NS = 1_700_000_000_000_000_000


def write_simple_registry(path, *, run_id="run-one"):
    data = {
        "vms": {"10.200.0.1": {"runId": run_id}},
        "updatedAt": 0,
    }
    path.write_text(json.dumps(data, sort_keys=True))


def pin_mtime(path):
    os.utime(path, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))


def write_firewall_registry(path, *, rule="/items"):
    data = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "firewalls": [
                    {
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
