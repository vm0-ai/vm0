"""Shared pending-state assertions for mitm-addon tests."""

import json
import os
from pathlib import Path


def _pending_state(path: Path) -> dict:
    return json.loads(path.read_text())


def assert_pending(
    path: Path,
    flows: int,
    buffered: int,
    reports: int,
    flush_request_id: str | None = None,
) -> dict:
    state = _pending_state(path)
    expected_fields = {
        "pid",
        "usageStateId",
        "updatedAtMs",
        "flows",
        "buffered",
        "reports",
    }
    if flush_request_id is not None:
        expected_fields.add("flushRequestId")
    assert set(state) == expected_fields
    assert state["pid"] == os.getpid()
    assert state["usageStateId"]
    assert isinstance(state["updatedAtMs"], int)
    assert state["flows"] == flows
    assert state["buffered"] == buffered
    assert state["reports"] == reports
    if flush_request_id is not None:
        assert state["flushRequestId"] == flush_request_id
    return state
