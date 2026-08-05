"""Common runner flush request marker envelope parsing."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple


class RunnerFlushRequest(NamedTuple):
    marker: dict[str, object]
    flush_request_id: str


def read_runner_flush_request(
    marker_path: Path,
    *,
    get_usage_state_id: Callable[[], str],
) -> RunnerFlushRequest | None:
    """Read a runner flush request for the expected addon generation."""
    try:
        marker: object = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(marker, dict):
        return None
    if marker.get("usageStateId") != get_usage_state_id():
        return None
    flush_request_id = marker.get("flushRequestId")
    if not isinstance(flush_request_id, str) or not flush_request_id:
        return None
    return RunnerFlushRequest(marker=marker, flush_request_id=flush_request_id)
