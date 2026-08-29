"""Tests for the addon-to-Runner process event boundary."""

import json
from unittest.mock import patch

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
        )

    write.assert_called_once()
    fd, record = write.call_args.args
    assert fd == 2
    assert _event_from_record(record) == {
        "version": 1,
        "level": "error",
        "message": "Failed to write pending count",
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
