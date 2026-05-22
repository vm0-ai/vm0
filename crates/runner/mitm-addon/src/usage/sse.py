"""Bounded Server-Sent Events scanner for usage extraction.

The scanner owns only SSE framing: line endings, event names, skipped events,
and ``data`` field boundaries.  Provider modules own JSON parsing and billing
field mapping through the callback interface below.
"""

from typing import Protocol

_CR = ord("\r")
_LF = ord("\n")
_SPACE = ord(" ")
_DATA_FIELD_PREFIX = b"data:"

# Non-data SSE control lines are expected to be tiny.  Cap malformed lines so
# an upstream bug cannot grow memory while we wait for a newline.
_MAX_CONTROL_LINE_BYTES = 4096


class SseUsageEventHandler(Protocol):
    """Provider-owned sink for target SSE event data."""

    def should_capture_event(self, event_name: str | None) -> bool:
        """Return whether data fields for *event_name* should be streamed."""
        raise NotImplementedError

    def on_event_start(self, event_name: str | None) -> None:
        """Called before the first captured data field in an event."""

    def on_data(self, chunk: bytes) -> None:
        """Called with bytes from a captured data field."""

    def on_data_separator(self) -> None:
        """Called between multiple captured data fields in one event."""

    def on_event_end(self, event_name: str | None) -> None:
        """Called when a captured event reaches a blank-line boundary."""

    def on_event_discard(self, event_name: str | None) -> None:
        """Called when an in-progress captured event must be discarded."""


class SseUsageScanner:
    """Incrementally scan SSE bytes and stream target ``data`` fields.

    This is deliberately not a full EventSource implementation and does not
    return assembled event bodies.  It keeps only bounded control-line state;
    captured ``data`` payload bytes are streamed directly to the handler.
    """

    def __init__(
        self,
        handler: SseUsageEventHandler,
        *,
        max_control_line_bytes: int = _MAX_CONTROL_LINE_BYTES,
        capture_data_without_event: bool = False,
    ) -> None:
        self._handler = handler
        self._max_control_line_bytes = max_control_line_bytes
        self._capture_data_without_event = capture_data_without_event
        self._event_name: str | None = None
        self._line_buf = bytearray()
        self._state = "line"
        self._discard_event = False
        self._skip_next_lf = False
        self._capturing_event = False
        self._captured_data_lines = 0

    def feed(self, chunk: bytes) -> None:
        i = 0
        while i < len(chunk):
            byte = chunk[i]
            if self._skip_next_lf:
                self._skip_next_lf = False
                if byte == _LF:
                    i += 1
                    continue

            if self._state == "data":
                i = self._consume_data(chunk, i)
            elif self._state == "data_prefix_space":
                i = self._consume_data_prefix_space(chunk, i)
            elif self._state == "discard_line":
                i = self._consume_discard_line(chunk, i)
            else:
                i = self._consume_line(chunk, i)

    def finish(self) -> None:
        """Flush a trailing event when the stream ends without a blank line."""

        if self._state == "data_prefix_space":
            self._start_data_line()
        elif self._state == "line" and self._line_buf:
            line = bytes(self._line_buf)
            self._line_buf.clear()
            self._process_control_line(line)

        self._state = "line"
        self._line_buf.clear()
        self._skip_next_lf = False
        if self._capturing_event:
            self._finish_event()
        else:
            self._event_name = None
            self._discard_event = False
            self._captured_data_lines = 0

    def _consume_line(self, chunk: bytes, i: int) -> int:
        byte = chunk[i]
        if _is_line_ending(byte):
            self._finish_control_line(byte)
            return i + 1

        self._line_buf.append(byte)
        if self._line_buf == _DATA_FIELD_PREFIX:
            self._line_buf.clear()
            self._state = "data_prefix_space"
        elif len(self._line_buf) > self._max_control_line_bytes:
            self._discard_malformed_control_line()
        return i + 1

    def _consume_data_prefix_space(self, chunk: bytes, i: int) -> int:
        byte = chunk[i]
        if _is_line_ending(byte):
            self._start_data_line()
            self._finish_data_or_discard_line(byte)
            return i + 1

        self._start_data_line()
        if byte == _SPACE:
            return i + 1
        return i

    def _consume_data(self, chunk: bytes, i: int) -> int:
        line_end = _find_next_line_ending(chunk, i)
        if line_end == -1:
            self._handler.on_data(chunk[i:])
            return len(chunk)

        if line_end > i:
            self._handler.on_data(chunk[i:line_end])
        self._finish_data_or_discard_line(chunk[line_end])
        return line_end + 1

    def _consume_discard_line(self, chunk: bytes, i: int) -> int:
        line_end = _find_next_line_ending(chunk, i)
        if line_end == -1:
            return len(chunk)

        self._finish_data_or_discard_line(chunk[line_end])
        return line_end + 1

    def _finish_control_line(self, line_ending: int) -> None:
        line = bytes(self._line_buf)
        self._line_buf.clear()
        self._process_control_line(line)
        self._state = "line"
        if line_ending == _CR:
            self._skip_next_lf = True

    def _finish_data_or_discard_line(self, line_ending: int) -> None:
        self._state = "line"
        if line_ending == _CR:
            self._skip_next_lf = True

    def _process_control_line(self, line: bytes) -> None:
        if line == b"":
            self._finish_event()
            return

        if self._discard_event:
            return

        if line == b"data":
            self._start_data_line()
            self._state = "line"
            return

        if line.startswith(b":"):
            return

        if b":" in line:
            field, value = line.split(b":", 1)
            if value.startswith(b" "):
                value = value[1:]
        else:
            field = line
            value = b""

        if field != b"event":
            return

        event_name = value.decode("utf-8", errors="replace")
        self._event_name = event_name
        if self._capturing_event and not self._handler.should_capture_event(event_name):
            self._discard_current_event(event_name)

    def _start_data_line(self) -> None:
        should_capture = self._handler.should_capture_event(self._event_name) or (
            self._event_name is None and self._capture_data_without_event
        )
        if self._discard_event or not should_capture:
            if not self._capturing_event:
                self._discard_event = True
            else:
                self._discard_current_event(self._event_name)
            self._state = "discard_line"
            return

        if not self._capturing_event:
            self._capturing_event = True
            self._captured_data_lines = 0
            self._handler.on_event_start(self._event_name)
        elif self._captured_data_lines > 0:
            self._handler.on_data_separator()

        self._captured_data_lines += 1
        self._state = "data"

    def _discard_malformed_control_line(self) -> None:
        self._line_buf.clear()
        if self._capturing_event or self._event_name is not None:
            self._discard_current_event(self._event_name)
        self._state = "discard_line"

    def _discard_current_event(self, event_name: str | None) -> None:
        if self._capturing_event:
            self._handler.on_event_discard(event_name)
        self._capturing_event = False
        self._captured_data_lines = 0
        self._discard_event = True

    def _finish_event(self) -> None:
        if self._capturing_event:
            self._handler.on_event_end(self._event_name)
        self._event_name = None
        self._discard_event = False
        self._capturing_event = False
        self._captured_data_lines = 0


def _is_line_ending(byte: int) -> bool:
    return byte in (_LF, _CR)


def _find_next_line_ending(chunk: bytes, start: int) -> int:
    next_lf = chunk.find(b"\n", start)
    next_cr = chunk.find(b"\r", start)
    if next_lf == -1:
        return next_cr
    if next_cr == -1:
        return next_lf
    return min(next_lf, next_cr)


class SseUsageParser:
    """Callable parser wrapper with an explicit stream-end flush hook."""

    def __init__(
        self,
        handler: SseUsageEventHandler,
        *,
        capture_data_without_event: bool = False,
    ) -> None:
        self._scanner = SseUsageScanner(
            handler,
            capture_data_without_event=capture_data_without_event,
        )

    def __call__(self, chunk: bytes) -> None:
        self.feed(chunk)

    def feed(self, chunk: bytes) -> None:
        self._scanner.feed(chunk)

    def finish(self) -> None:
        self._scanner.finish()
