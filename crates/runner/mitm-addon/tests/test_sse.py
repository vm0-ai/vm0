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


def test_finish_flushes_current_event_without_blank_line() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\ndata: ok")
    scanner.finish()
    scanner.finish()

    assert handler.events == [("target", b"ok")]


def test_callable_scanner_feeds_chunks_and_finish_flushes() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner(b"event: target\n")
    scanner(b"data: ok")
    scanner.finish()

    assert handler.events == [("target", b"ok")]


def test_ignores_comment_only_frame() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b": heartbeat\n\n")

    assert handler.started == []
    assert handler.events == []
    assert handler.discarded == []


def test_comment_does_not_break_event_stream() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\n: keepalive\ndata: ok\n\n")

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_bare_data_field_without_colon_emits_empty_data() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\ndata\n\n")

    assert handler.started == ["target"]
    assert handler.events == [("target", b"")]
    assert handler.discarded == []


def test_supports_no_optional_space_and_split_crlf() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event:target\r")
    scanner.feed(b"\ndata:payload\r")
    scanner.feed(b"\n\r")
    scanner.feed(b"\n")

    assert handler.events == [("target", b"payload")]


def test_can_capture_data_before_target_event_name() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler, capture_data_without_event=True)

    scanner.feed(b"data: ok\n")
    scanner.feed(b"event: target\n\n")

    assert handler.events == [("target", b"ok")]


def test_discards_data_before_ignored_event_name() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler, capture_data_without_event=True)

    scanner.feed(b"data: ignored\n")
    scanner.feed(b"event: ignored\n\n")

    assert handler.events == []
    assert handler.discarded == ["ignored"]


def test_event_name_can_change_before_data_starts() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: ignored\n")
    scanner.feed(b"event: target\n")
    scanner.feed(b"data: ok\n\n")

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_target_after_discarded_data_does_not_emit_partial_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: ignored\n")
    scanner.feed(b"data: already-discarded\n")
    scanner.feed(b"event: target\n")
    scanner.feed(b"data: partial\n\n")

    assert handler.events == []
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


def test_long_malformed_control_line_discards_current_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: target\n"
        b"data: partial\n" + b"x" * 5000 + b"\n\n" + b"event: target\n" + b"data: ok\n\n"
    )

    assert handler.discarded == ["target"]
    assert handler.events == [("target", b"ok")]
