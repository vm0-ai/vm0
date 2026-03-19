import json

import pytest


@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file and return its path."""
    registry = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "sandboxToken": "tok-xyz",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network.jsonl"),
            },
            "10.200.0.2": {
                "runId": "run-def-456",
                "sandboxToken": "tok-abc",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network-2.jsonl"),
            },
        },
        "updatedAt": 1700000000000,
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path
