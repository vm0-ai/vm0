"""Bound decoded WebSocket messages before mitmproxy's addon hooks."""

from __future__ import annotations

import zlib
from collections.abc import Generator
from dataclasses import dataclass
from typing import cast

import wsproto
from mitmproxy import connection
from mitmproxy.proxy import commands
from mitmproxy.proxy.layers import websocket
from wsproto import events
from wsproto.extensions import Extension, PerMessageDeflate
from wsproto.frame_protocol import CloseReason, FrameDecoder, FrameProtocol, Opcode, RsvBits

MAX_DECODED_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_MESSAGE_DATA_FRAMES = 8_192

_EMPTY_DEFLATE_BLOCK = b"\x00\x00\xff\xff"
_CONNECTION_MARKER_ATTRIBUTE = "_vm0_bounded_websocket_framing"
_ORIGINAL_WEBSOCKET_CONNECTION = websocket.WebsocketConnection


@dataclass
class _MessageBudget:
    max_decoded_bytes: int
    max_data_frames: int
    decoded_bytes: int = 0
    data_frames: int = 0

    @property
    def remaining_bytes(self) -> int:
        return self.max_decoded_bytes - self.decoded_bytes

    def reserve_bytes(self, size: int) -> bool:
        if size > self.remaining_bytes:
            return False
        self.decoded_bytes += size
        return True

    def reserve_frame(self) -> bool:
        if self.data_frames >= self.max_data_frames:
            return False
        self.data_frames += 1
        return True

    def reset(self) -> None:
        self.decoded_bytes = 0
        self.data_frames = 0


class _DecodedMessageLimit(Extension):
    """Count decoded data after negotiated inbound extensions run."""

    name = "vm0-decoded-message-limit"

    def __init__(self, budget: _MessageBudget) -> None:
        self._budget = budget
        self._opcode: Opcode | None = None
        self._frame_started = False

    def enabled(self) -> bool:
        return True

    def offer(self) -> bool:
        return False

    def frame_inbound_header(
        self,
        proto: FrameDecoder | FrameProtocol,
        opcode: Opcode,
        rsv: RsvBits,
        payload_length: int,
    ) -> RsvBits:
        self._opcode = opcode
        return RsvBits(False, False, False)

    def frame_inbound_payload_data(
        self,
        proto: FrameDecoder | FrameProtocol,
        data: bytes,
    ) -> bytes | CloseReason:
        opcode = self._opcode
        if opcode is None:
            raise RuntimeError("WebSocket payload arrived without a frame header")
        if opcode.iscontrol():
            return data

        if not self._frame_started:
            self._frame_started = True
            if not self._budget.reserve_frame():
                return CloseReason.MESSAGE_TOO_BIG

        if not self._budget.reserve_bytes(len(data)):
            return CloseReason.MESSAGE_TOO_BIG
        return data

    def frame_inbound_complete(
        self,
        proto: FrameDecoder | FrameProtocol,
        fin: bool,
    ) -> None:
        opcode = self._opcode
        if opcode is None:
            raise RuntimeError("WebSocket frame completed without a frame header")
        is_control = opcode.iscontrol()
        self._opcode = None
        self._frame_started = False
        if fin and not is_control:
            self._budget.reset()

    def clear(self) -> None:
        self._opcode = None
        self._frame_started = False
        self._budget.reset()


class _BoundedPerMessageDeflate(PerMessageDeflate):
    """Apply the shared decoded-message budget while inflating input."""

    def __init__(self, source: PerMessageDeflate, budget: _MessageBudget) -> None:
        super().__init__(
            client_no_context_takeover=source.client_no_context_takeover,
            client_max_window_bits=source.client_max_window_bits,
            server_no_context_takeover=source.server_no_context_takeover,
            server_max_window_bits=source.server_max_window_bits,
        )
        if not source.enabled():
            raise RuntimeError("mitmproxy passed a disabled permessage-deflate extension")
        self.finalize(self.name)
        self._budget = budget

    def _discard_inbound_state(self) -> None:
        self._decompressor = None
        self._inbound_is_compressible = None
        self._inbound_compressed = None
        self._budget.reset()

    def clear(self) -> None:
        self._compressor = None
        self._discard_inbound_state()

    def _decompress_bounded(self, data: bytes) -> bytes | CloseReason:
        decompressor = self._decompressor
        if decompressor is None:
            raise RuntimeError("compressed WebSocket data arrived without a decompressor")
        remaining = self._budget.remaining_bytes
        try:
            decoded = decompressor.decompress(data, remaining + 1)
        except zlib.error:
            self._discard_inbound_state()
            return CloseReason.INVALID_FRAME_PAYLOAD_DATA

        if len(decoded) > remaining or decompressor.unconsumed_tail:
            self._discard_inbound_state()
            return CloseReason.MESSAGE_TOO_BIG
        return decoded

    def frame_inbound_payload_data(
        self,
        proto: FrameDecoder | FrameProtocol,
        data: bytes,
    ) -> bytes | CloseReason:
        if not self._inbound_compressed or not self._inbound_is_compressible:
            return data
        return self._decompress_bounded(bytes(data))

    def frame_inbound_complete(
        self,
        proto: FrameDecoder | FrameProtocol,
        fin: bool,
    ) -> bytes | CloseReason | None:
        if not fin:
            return None
        if not self._inbound_is_compressible:
            self._inbound_compressed = None
            return None
        if not self._inbound_compressed:
            self._inbound_compressed = None
            return None

        decoded = self._decompress_bounded(_EMPTY_DEFLATE_BLOCK)
        if isinstance(decoded, CloseReason):
            return decoded
        if not self._budget.reserve_bytes(len(decoded)):
            self._discard_inbound_state()
            return CloseReason.MESSAGE_TOO_BIG

        if proto.client:
            no_context_takeover = self.server_no_context_takeover
        else:
            no_context_takeover = self.client_no_context_takeover
        if no_context_takeover:
            self._decompressor = None

        self._inbound_compressed = None
        return decoded


class _BoundedWebsocketConnection(_ORIGINAL_WEBSOCKET_CONNECTION):
    """Pinned mitmproxy connection with bounded inbound message state."""

    def __init__(
        self,
        connection_type: wsproto.ConnectionType,
        extensions: list[Extension] | None = None,
        trailing_data: bytes = b"",
        *,
        conn: connection.Connection,
    ) -> None:
        budget = _MessageBudget(
            max_decoded_bytes=MAX_DECODED_MESSAGE_BYTES,
            max_data_frames=MAX_MESSAGE_DATA_FRAMES,
        )
        bounded_extensions: list[Extension] = []
        bounded_deflates: list[_BoundedPerMessageDeflate] = []
        for extension in extensions or []:
            if isinstance(extension, PerMessageDeflate):
                bounded_deflate = _BoundedPerMessageDeflate(extension, budget)
                bounded_extensions.append(bounded_deflate)
                bounded_deflates.append(bounded_deflate)
            else:
                bounded_extensions.append(extension)

        message_limit = _DecodedMessageLimit(budget)
        bounded_extensions.append(message_limit)
        super().__init__(
            connection_type,
            bounded_extensions,
            trailing_data,
            conn=conn,
        )
        self._vm0_message_limit = message_limit
        self._vm0_bounded_deflates = bounded_deflates
        self.frame_buf = [self._mutable_fragment()]

    @staticmethod
    def _mutable_fragment(data: bytes = b"") -> bytes:
        # mitmproxy types frame_buf as list[bytes], but bytearray is accepted by
        # bytes.join and makes its existing ``frame_buf[-1] += data`` mutate.
        return cast(bytes, bytearray(data))

    def _ensure_mutable_fragment(self) -> None:
        if not self.frame_buf:
            self.frame_buf.append(self._mutable_fragment())
        elif isinstance(self.frame_buf[-1], bytes):
            self.frame_buf[-1] = self._mutable_fragment(self.frame_buf[-1])

    def _clear_partial_state(self) -> None:
        self.frame_buf = [self._mutable_fragment()]
        self._vm0_message_limit.clear()
        for extension in self._vm0_bounded_deflates:
            extension.clear()

    def events(self) -> Generator[events.Event, None, None]:
        try:
            for event in super().events():
                if isinstance(event, events.CloseConnection):
                    self._clear_partial_state()
                yield event
                self._ensure_mutable_fragment()
        finally:
            self._ensure_mutable_fragment()

    def send2(self, event: events.Event) -> commands.SendData:
        if isinstance(event, events.CloseConnection):
            self._clear_partial_state()
        return super().send2(event)


setattr(_BoundedWebsocketConnection, _CONNECTION_MARKER_ATTRIBUTE, True)


def install_websocket_framing() -> None:
    """Install the pinned connection class once."""
    current_connection = websocket.WebsocketConnection
    if hasattr(current_connection, _CONNECTION_MARKER_ATTRIBUTE):
        return
    if current_connection is not _ORIGINAL_WEBSOCKET_CONNECTION:
        raise RuntimeError("mitmproxy WebsocketConnection has an incompatible shape")
    websocket.WebsocketConnection = _BoundedWebsocketConnection
