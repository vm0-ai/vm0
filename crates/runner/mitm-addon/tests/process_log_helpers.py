"""Test capture for addon process events."""

import json
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import addon_process_logging


@contextmanager
def capture_addon_process_events() -> Iterator[MagicMock]:
    """Capture the external stderr write after real event serialization."""
    log = MagicMock()

    def capture(fd: int, record: bytes) -> int:
        assert fd == 2
        prefix = addon_process_logging.ADDON_PROCESS_EVENT_PREFIX.encode()
        assert record.startswith(prefix)
        assert record.endswith(b"\n")
        payload = json.JSONDecoder().decode(record[len(prefix) :].decode())
        assert isinstance(payload, dict)
        level = payload.get("level")
        detail = payload.get("detail")
        assert level in ("warn", "error")
        assert isinstance(detail, str)
        getattr(log, level)(detail)
        return len(record)

    stderr = MagicMock()
    stderr.write.side_effect = capture
    with patch.object(addon_process_logging, "os", stderr):
        yield log
