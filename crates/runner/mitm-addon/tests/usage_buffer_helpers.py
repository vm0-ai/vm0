"""Shared helpers for usage-buffer behavior tests."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import usage.buffer as usage_buffer


def event(
    *,
    source_key: str,
    category: str = "tokens.input",
    quantity: int = 1,
    kind: str = "model",
    provider: str = "claude-sonnet-4-6",
) -> usage_buffer.UsageEvent:
    return {
        "idempotencyKey": source_key,
        "kind": kind,
        "provider": provider,
        "category": category,
        "quantity": quantity,
    }


@dataclass(frozen=True)
class RecordedEnqueueCall:
    url: str
    sandbox_token: str
    payload: dict
    proxy_log_path: str
    log_type: str


RecordingEnqueueSideEffect = Callable[[str, str, dict, str, str], bool | None]


class RecordingEnqueue:
    def __init__(
        self,
        *,
        return_value: bool = True,
        side_effect: RecordingEnqueueSideEffect | None = None,
    ) -> None:
        self.return_value = return_value
        self.side_effect = side_effect
        self.calls: list[RecordedEnqueueCall] = []

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def payloads(self) -> list[dict]:
        return payloads_from_enqueue_calls(self.calls)

    @property
    def last_call(self) -> RecordedEnqueueCall:
        return self.calls[-1]

    def __call__(
        self,
        url: str,
        sandbox_token: str,
        payload: dict,
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        self.calls.append(
            RecordedEnqueueCall(
                url=url,
                sandbox_token=sandbox_token,
                payload=payload,
                proxy_log_path=proxy_log_path,
                log_type=log_type,
            )
        )
        if self.side_effect is None:
            return self.return_value
        result = self.side_effect(url, sandbox_token, payload, proxy_log_path, log_type)
        return self.return_value if result is None else result

    def clear(self) -> None:
        self.calls.clear()

    def assert_called_once(self) -> None:
        assert self.call_count == 1

    def assert_not_called(self) -> None:
        assert self.call_count == 0


def payloads_from_enqueue_calls(calls: Sequence[RecordedEnqueueCall]) -> list[dict]:
    return [call.payload for call in calls]


def flush_log_entries(proxy_log_path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in proxy_log_path.read_text().splitlines()
        if '"usage_event_buffer_flush"' in line
    ]
