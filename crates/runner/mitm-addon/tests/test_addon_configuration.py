"""Tests for mitm addon configuration hooks."""

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from mitmproxy.addonmanager import Loader

import mitm_addon
import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_pending


@dataclass(frozen=True)
class _RecordedOption:
    name: str
    typespec: type
    default: object
    help: str
    choices: Sequence[str] | None


class _RecordingOptions:
    def __init__(self) -> None:
        self.added: list[_RecordedOption] = []
        self._options: dict[str, _RecordedOption] = {}

    def __contains__(self, name: str) -> bool:
        return name in self._options

    def add_option(
        self,
        name: str,
        typespec: type,
        default: object,
        help_text: str,
        choices: Sequence[str] | None = None,
    ) -> None:
        option = _RecordedOption(name, typespec, default, help_text, choices)
        self.added.append(option)
        self._options[name] = option


class _RecordingMaster:
    def __init__(self) -> None:
        self.options = _RecordingOptions()


class _Options:
    def __init__(
        self,
        *,
        usage_state_id: str = "runner-usage-state-id",
        flush_interval_seconds: float = usage.DEFAULT_FLUSH_INTERVAL_SECONDS,
    ) -> None:
        self.vm0_usage_state_id = usage_state_id
        self.vm0_usage_flush_interval_seconds = flush_interval_seconds


class _FakeTimer:
    def __init__(self, delay: float, callback: Callable[[], None]) -> None:
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.cancelled = False
        self.started = False

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True


def _addon_file_path(tmp_path: Path) -> str:
    return str(tmp_path / "mitm_addon.py")


def _usage_event(source_key: str) -> usage_buffer.UsageEvent:
    return {
        "idempotencyKey": source_key,
        "kind": "model",
        "provider": "claude-sonnet-4-6",
        "category": "tokens.input",
        "quantity": 1,
    }


class TestAddonConfiguration:
    def test_load_registers_usage_options_and_signal_handler_without_pending_write(self, tmp_path):
        master = _RecordingMaster()
        loader = Loader(master)
        pending_path = tmp_path / "usage-pending"

        # OS signal registration is process-global boundary state. Handler
        # behavior is covered by test_connection_hooks.py.
        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.signal, "signal") as signal_handler,
        ):
            mitm_addon.load(loader)

        option_names = [option.name for option in master.options.added]
        assert "vm0_usage_state_id" in option_names
        assert "vm0_usage_flush_interval_seconds" in option_names
        assert not pending_path.exists()
        signal_handler.assert_called_once_with(
            mitm_addon._RUNNER_USAGE_FLUSH_SIGNAL,
            mitm_addon._handle_runner_usage_flush_signal,
        )

    def test_configure_writes_pending_state_with_usage_state_id(self, tmp_path):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.ctx, "options", _Options(), create=True),
        ):
            mitm_addon.configure({"vm0_usage_state_id"})

        state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        assert state["usageStateId"] == "runner-usage-state-id"

    def test_configure_writes_fallback_pending_state_id_when_usage_state_id_is_empty(
        self, tmp_path
    ):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(usage_state_id=""),
                create=True,
            ),
        ):
            mitm_addon.configure({"vm0_usage_state_id"})

        state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        uuid.UUID(state["usageStateId"])

    def test_configure_ignores_unrelated_option_updates(self, tmp_path):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.ctx, "options", _Options(), create=True),
        ):
            mitm_addon.configure({"vm0_api_url"})

        assert not pending_path.exists()

    def test_configure_updates_usage_flush_interval(self, tmp_path):
        timers: list[_FakeTimer] = []
        flush_interval_seconds = 15.0
        jitter_seconds = flush_interval_seconds * usage_buffer.DEFAULT_FLUSH_JITTER_RATIO

        def timer_factory(delay: float, callback: Callable[[], None]) -> _FakeTimer:
            timer = _FakeTimer(delay, callback)
            timers.append(timer)
            return timer

        usage.reset_usage_buffer_for_tests(timer_enabled=True, timer_factory=timer_factory)

        with patch.object(
            mitm_addon.ctx,
            "options",
            _Options(flush_interval_seconds=flush_interval_seconds),
            create=True,
        ):
            mitm_addon.configure({"vm0_usage_flush_interval_seconds"})

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_usage_event("source-1")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert len(timers) == 1
        assert timers[0].started is True
        assert max(0.001, flush_interval_seconds - jitter_seconds) <= timers[0].delay
        assert timers[0].delay <= flush_interval_seconds + jitter_seconds
