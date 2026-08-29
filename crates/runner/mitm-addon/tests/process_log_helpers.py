"""Test capture for addon process events."""

from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import addon_process_logging


@contextmanager
def capture_addon_process_events() -> Iterator[MagicMock]:
    """Expose WARN and ERROR event details through a small mock log."""
    log = MagicMock()

    def capture(
        level: addon_process_logging.AddonProcessEventLevel,
        _event_type: str,
        _reason: str,
        /,
        *,
        detail: str,
        underbilling_class: addon_process_logging.UnderbillingClass | None = None,
        counter: str | None = None,
    ) -> None:
        del underbilling_class, counter
        getattr(log, level)(detail)

    with patch.object(
        addon_process_logging,
        "emit_addon_process_event",
        side_effect=capture,
    ):
        yield log
