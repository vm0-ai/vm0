import json
import pytest
from pathlib import Path


@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file and return its path."""
    registry = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "sandboxToken": "tok-xyz",
                "mitmEnabled": True,
                "sealSecretsEnabled": False,
                "registeredAt": 1700000000000,
                "firewallRules": [
                    {"domain": "*.vm0.ai", "action": "ALLOW"},
                    {"domain": "*.anthropic.com", "action": "ALLOW"},
                    {"final": "DENY"},
                ],
                "networkLogPath": str(tmp_path / "network.jsonl"),
            },
            "10.200.0.2": {
                "runId": "run-def-456",
                "sandboxToken": "tok-abc",
                "mitmEnabled": False,
                "sealSecretsEnabled": False,
                "registeredAt": 1700000000000,
                "firewallRules": [],
                "networkLogPath": str(tmp_path / "network-2.jsonl"),
            },
        },
        "updatedAt": 1700000000000,
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path
