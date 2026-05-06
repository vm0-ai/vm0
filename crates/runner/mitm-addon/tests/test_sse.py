"""Tests for the bounded usage SSE scanner."""

import pytest

from usage.sse import SseUsageScanner


class _CaptureHandler:
    def __init__(self, target_events: set[str | None]) -> None:
        self.target_events = target_events
        self.current: bytearray | None = None
        self.started: list[str | None] = []
        self.events: list[tuple[str | None, bytes]] = []
        self.discarded: list[str | None] = []

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name in self.target_events

    def on_event_start(self, event_name: str | None) -> None:
        self.started.append(event_name)
        self.current = bytearray()

    def on_data(self, chunk: bytes) -> None:
        assert self.current is not None
        self.current.extend(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        assert self.current is not None
        self.events.append((event_name, bytes(self.current)))
        self.current = None

    def on_event_discard(self, event_name: str | None) -> None:
        self.discarded.append(event_name)
        self.current = None


def test_streams_target_multi_data_with_newline_injection() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"eve")
    scanner.feed(b"nt: target\nda")
    scanner.feed(b'ta: {"a":')
    scanner.feed(b"\ndata:")
    scanner.feed(b" 1}\n\n")

    assert handler.started == ["target"]
    assert handler.events == [("target", b'{"a":\n1}')]
    assert handler.discarded == []


@pytest.mark.parametrize("newline", [b"\n", b"\r\n", b"\r"])
def test_supports_sse_line_endings(newline: bytes) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target" + newline + b"data: payload" + newline + newline)

    assert handler.events == [("target", b"payload")]


def test_skips_large_ignored_event_and_recovers_in_same_chunk() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: ignored\n"
        + b"data: "
        + b"x" * 200_000
        + b"\n\n"
        + b"event: target\n"
        + b"data: ok\n\n"
    )

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_long_malformed_control_line_recovers_for_next_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"x" * 5000 + b"\n" + b"event: target\n" + b"data: ok\n\n")

    assert handler.events == [("target", b"ok")]
