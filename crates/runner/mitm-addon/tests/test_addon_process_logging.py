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
            "usage_underbilling",
            "pending_snapshot_write_failed",
            message="Failed to write pending count",
            fields={"underbilling_class": "risk", "counter": "reports"},
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
        "fields": {"counter": "reports", "underbilling_class": "risk"},
        "message": "Failed to write pending count",
    }


def test_bounds_and_single_lines_control_heavy_message() -> None:
    message = "\x00\n" * 4096

    with patch.object(addon_process_logging.os, "write", return_value=1) as write:
        addon_process_logging.emit_addon_process_event(
            "warn",
            "addon_process_integrity",
            "jsonl_writer_append_failed",
            message=message,
        )

    [record] = [write.call_args.args[1]]
    assert len(record) <= addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES
    assert record.count(b"\n") == 1
    event = _event_from_record(record)
    assert isinstance(event["message"], str)
    assert event["message"].endswith("...")


@pytest.mark.parametrize(
    ("event_type", "reason", "fields"),
    [
        ("Bad Type", "valid_reason", None),
        ("valid_type", "bad reason", None),
        ("valid_type", "valid_reason", {"bad field": "value"}),
    ],
)
def test_rejects_unstable_root_field_names(
    event_type: str,
    reason: str,
    fields: dict[str, str] | None,
) -> None:
    with pytest.raises(ValueError, match="invalid addon process event"):
        addon_process_logging.emit_addon_process_event(
            "warn",
            event_type,
            reason,
            message="failed",
            fields=fields,
        )


def test_rejects_oversized_generic_fields() -> None:
    fields = {
        f"field_{index}": "value"
        for index in range(addon_process_logging.MAX_ADDON_PROCESS_EVENT_FIELDS + 1)
    }
    with pytest.raises(ValueError, match="too many addon process event fields"):
        addon_process_logging.emit_addon_process_event(
            "error",
            "usage_underbilling",
            "test_failure",
            message="failed",
            fields=fields,
        )


def test_stderr_write_failure_does_not_escape() -> None:
    with patch.object(addon_process_logging.os, "write", side_effect=OSError("closed")):
        addon_process_logging.emit_addon_process_event(
            "warn",
            "addon_process_integrity",
            "jsonl_writer_append_failed",
            message="write failed",
        )
