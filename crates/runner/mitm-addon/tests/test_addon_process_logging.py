"""Tests for the addon-to-Runner process event boundary."""

import json
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
            "Failed to write pending count",
            type="usage_underbilling",
            reason="pending_snapshot_write_failed",
            underbilling_class="risk",
            retry_count=2,
            retryable=True,
            diagnostic={"phase": "flush"},
            **{"future.field-name": ["value", 3]},
        )

    write.assert_called_once()
    fd, record = write.call_args.args
    assert fd == 2
    assert _event_from_record(record) == {
        "version": 1,
        "level": "error",
        "message": "Failed to write pending count",
        "type": "usage_underbilling",
        "reason": "pending_snapshot_write_failed",
        "underbilling_class": "risk",
        "retry_count": 2,
        "retryable": True,
        "diagnostic": {"phase": "flush"},
        "future.field-name": ["value", 3],
    }


def test_logger_owned_fields_cannot_be_overridden() -> None:
    with patch.object(addon_process_logging.os, "write", return_value=1) as write:
        addon_process_logging.emit_addon_process_event(
            "error",
            "owned message",
            version=2,
            level="warn",
            message="wrong message",
        )

    event = _event_from_record(write.call_args.args[1])
    assert event == {
        "version": 1,
        "level": "error",
        "message": "owned message",
    }


def test_bounds_and_single_lines_control_heavy_message() -> None:
    message = "\x00\n" * 4096

    with patch.object(addon_process_logging.os, "write", return_value=1) as write:
        addon_process_logging.emit_addon_process_event(
            "warn",
            message,
        )

    [record] = [write.call_args.args[1]]
    assert len(record) <= addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES
    assert record.count(b"\n") == 1
    event = _event_from_record(record)
    assert isinstance(event["message"], str)
    assert event["message"].endswith("...")


def test_stderr_write_failure_does_not_escape() -> None:
    with patch.object(addon_process_logging.os, "write", side_effect=OSError("closed")):
        addon_process_logging.emit_addon_process_event(
            "warn",
            "write failed",
        )


def test_rejects_fields_that_exceed_record_limit() -> None:
    with (
        patch.object(addon_process_logging.os, "write") as write,
        pytest.raises(
            ValueError,
            match="addon process event fields exceed the record size limit",
        ),
    ):
        addon_process_logging.emit_addon_process_event(
            "warn",
            "write failed",
            oversized="x" * addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES,
        )

    write.assert_not_called()
