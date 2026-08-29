"""Tests for the addon-to-Runner process event boundary."""

import json
from typing import cast
from unittest.mock import patch

import pytest

import addon_process_logging


def _event_from_record(record: bytes) -> dict[str, object]:
    assert record.endswith(b"\n")
    prefix = addon_process_logging.ADDON_PROCESS_EVENT_PREFIX.encode()
    assert record.startswith(prefix)
    return json.loads(record[len(prefix) :])


def test_emits_one_versioned_stderr_record() -> None:
    with patch.object(addon_process_logging.os, "write", return_value=1) as write:
        addon_process_logging.emit_addon_process_event(
            "error",
            "usage_underbilling",
            "pending_snapshot_write_failed",
            detail="Failed to write pending count",
            underbilling_class="risk",
            counter="reports",
        )

    write.assert_called_once()
    fd, record = write.call_args.args
    assert fd == 2
    assert _event_from_record(record) == {
        "version": 1,
        "level": "error",
        "type": "usage_underbilling",
        "reason": "pending_snapshot_write_failed",
        "component": "mitm_addon",
        "underbilling_class": "risk",
        "counter": "reports",
        "detail": "Failed to write pending count",
    }


def test_bounds_and_single_lines_control_heavy_detail() -> None:
    detail = "\x00\n" * 4096

    with patch.object(addon_process_logging.os, "write", return_value=1) as write:
        addon_process_logging.emit_addon_process_event(
            "warn",
            "addon_process_integrity",
            "jsonl_writer_append_failed",
            detail=detail,
        )

    [record] = [write.call_args.args[1]]
    assert len(record) <= addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES
    assert record.count(b"\n") == 1
    event = _event_from_record(record)
    assert isinstance(event["detail"], str)
    assert event["detail"].endswith("...")


@pytest.mark.parametrize(
    ("event_type", "reason", "counter"),
    [
        ("Bad Type", "valid_reason", None),
        ("valid_type", "bad reason", None),
        ("valid_type", "valid_reason", "bad counter"),
    ],
)
def test_rejects_unstable_root_field_names(
    event_type: str,
    reason: str,
    counter: str | None,
) -> None:
    with pytest.raises(ValueError, match="invalid addon process event"):
        addon_process_logging.emit_addon_process_event(
            "warn",
            event_type,
            reason,
            detail="failed",
            counter=counter,
        )


def test_rejects_invalid_underbilling_class() -> None:
    with pytest.raises(ValueError, match="invalid addon process event underbilling_class"):
        addon_process_logging.emit_addon_process_event(
            "error",
            "usage_underbilling",
            "test_failure",
            detail="failed",
            underbilling_class=cast(addon_process_logging.UnderbillingClass, "invalid"),
        )


def test_stderr_write_failure_does_not_escape() -> None:
    with patch.object(addon_process_logging.os, "write", side_effect=OSError("closed")):
        addon_process_logging.emit_addon_process_event(
            "warn",
            "addon_process_integrity",
            "jsonl_writer_append_failed",
            detail="write failed",
        )
