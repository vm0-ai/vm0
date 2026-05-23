"""Shared pending-state assertions for mitm-addon tests."""

import json
import os
from pathlib import Path


def _pending_state(path: Path) -> dict:
    return json.loads(path.read_text())


def _assert_pending(path: Path, flows: int, reports: int) -> dict:
    state = _pending_state(path)
    assert set(state) == {
        "version",
        "pid",
        "usageStateId",
        "updatedAtMs",
        "flows",
        "reports",
    }
    assert state["version"] == 1
    assert state["pid"] == os.getpid()
    assert state["usageStateId"]
    assert isinstance(state["updatedAtMs"], int)
    assert state["flows"] == flows
    assert state["reports"] == reports
    return state
