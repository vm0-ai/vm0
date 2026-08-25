"""Shared deferred callback scheduling helpers for mitm addon tests."""

from collections.abc import Callable

import pytest

import deferred_callbacks

type ScheduledCallback = Callable[[], None]


def capture_deferred_callbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledCallback]:
    scheduled: list[ScheduledCallback] = []

    def call_soon[CallbackArg](callback: Callable[[CallbackArg], None], arg: CallbackArg) -> None:
        def run_callback() -> None:
            callback(arg)

        scheduled.append(run_callback)

    monkeypatch.setattr(deferred_callbacks, "call_soon", call_soon)
    return scheduled


def run_deferred_callbacks(scheduled: list[ScheduledCallback]) -> None:
    pending = list(scheduled)
    scheduled.clear()
    for callback in pending:
        callback()
