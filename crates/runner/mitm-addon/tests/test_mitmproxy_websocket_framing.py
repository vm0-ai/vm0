"""WebSocket framing integration tests through mitmproxy's real hook pipeline."""

import weakref
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from unittest.mock import patch

import pytest
import wsproto
import wsproto.events
import wsproto.extensions
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.commands import StartHook
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers import websocket
from mitmproxy.test import taddons
from mitmproxy.websocket import WebSocketData
from wsproto.connection import Connection as WsprotoConnection

import flow_metadata_keys as metadata_keys
import mitm_addon
import websocket_framing

_CLIENT_IP = "10.200.0.5"
_HOST = "websocket.example.com"
_PERMESSAGE_DEFLATE = "permessage-deflate"


@dataclass
class _RunningWebSocket:
    layer: websocket.WebsocketLayer
    flow: http.HTTPFlow
    client: connection.Client
    server: connection.Server


class _ZlibDecompressor(Protocol):
    def decompress(self, data: bytes, /, max_length: int = 0) -> bytes: ...

    @property
    def unconsumed_tail(self) -> bytes: ...


@dataclass
class _DecompressionStats:
    max_lengths: list[int] = field(default_factory=list)
    output_sizes: list[int] = field(default_factory=list)
    instances: list[weakref.ReferenceType["_TrackingDecompressor"]] = field(default_factory=list)


class _TrackingDecompressor:
    def __init__(self, inner: _ZlibDecompressor, stats: _DecompressionStats) -> None:
        self._inner = inner
        self._stats = stats

    def decompress(self, data: bytes, /, max_length: int = 0) -> bytes:
        decoded = self._inner.decompress(data, max_length)
        self._stats.max_lengths.append(max_length)
        self._stats.output_sizes.append(len(decoded))
        return decoded

    @property
    def unconsumed_tail(self) -> bytes:
        return self._inner.unconsumed_tail


def _track_zlib_decompression(
    monkeypatch: pytest.MonkeyPatch,
) -> _DecompressionStats:
    real_decompressobj = zlib.decompressobj
    stats = _DecompressionStats()

    def tracking_decompressobj(
        wbits: int = zlib.MAX_WBITS,
        zdict: bytes | None = None,
    ) -> _TrackingDecompressor:
        if zdict is None:
            inner = real_decompressobj(wbits)
        else:
            inner = real_decompressobj(wbits, zdict=zdict)
        tracked = _TrackingDecompressor(inner, stats)
        stats.instances.append(weakref.ref(tracked))
        return tracked

    monkeypatch.setattr(websocket_framing.zlib, "decompressobj", tracking_decompressobj)
    return stats


async def _handle_event(
    addon_context: taddons.context,
    running: _RunningWebSocket,
    event: events.Event,
) -> list[commands.Command]:
    observed: list[commands.Command] = []
    pending = [event]
    while pending:
        emitted = list(running.layer.handle_event(pending.pop(0)))
        observed.extend(emitted)
        for command in emitted:
            if isinstance(command, StartHook):
                await addon_context.master.addons.invoke_addon(mitm_addon, command)
                pending.append(events.HookCompleted(command, None))
    return observed


async def _start_websocket(
    addon_context: taddons.context,
    *,
    permessage_deflate: str | None = None,
    run_id: str | None = None,
) -> _RunningWebSocket:
    client = connection.Client(
        peername=(_CLIENT_IP, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
    )
    context = Context(client, addon_context.options)
    context.server.address = (_HOST, 443)
    context.server.state = connection.ConnectionState.OPEN

    flow = http.HTTPFlow(context.client, context.server)
    flow.request = http.Request.make(
        "GET",
        f"https://{_HOST}/socket",
        headers={
            "Connection": "upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
        },
    )
    response_headers = {
        "Connection": "upgrade",
        "Upgrade": "websocket",
    }
    if permessage_deflate is not None:
        response_headers["Sec-WebSocket-Extensions"] = permessage_deflate
    flow.response = http.Response.make(101, headers=response_headers)
    flow.websocket = WebSocketData()
    if run_id is not None:
        flow.metadata[metadata_keys.VM_RUN_ID] = run_id

    running = _RunningWebSocket(
        layer=websocket.WebsocketLayer(context, flow),
        flow=flow,
        client=context.client,
        server=context.server,
    )
    start_commands = await _handle_event(addon_context, running, events.Start())
    assert sum(isinstance(command, websocket.WebsocketStartHook) for command in start_commands) == 1
    return running


def _peer(
    *,
    from_client: bool,
    permessage_deflate: str | None = None,
) -> WsprotoConnection:
    extensions: list[wsproto.extensions.Extension] = []
    if permessage_deflate is not None:
        extension = wsproto.extensions.PerMessageDeflate()
        extension.finalize(permessage_deflate)
        extensions.append(extension)
    connection_type = (
        wsproto.ConnectionType.CLIENT if from_client else wsproto.ConnectionType.SERVER
    )
    return WsprotoConnection(connection_type, extensions)


def _message_event(
    content: bytes | str,
    *,
    message_finished: bool = True,
) -> wsproto.events.Message:
    if isinstance(content, str):
        return wsproto.events.TextMessage(content, message_finished=message_finished)
    return wsproto.events.BytesMessage(content, message_finished=message_finished)


def _malformed_compressed_binary_frame(*, from_client: bool) -> bytes:
    payload = b"\x04"
    if not from_client:
        return b"\xc2\x01" + payload

    masking_key = b"\x01\x02\x03\x04"
    masked_payload = bytes([payload[0] ^ masking_key[0]])
    return b"\xc2\x81" + masking_key + masked_payload


def _source_connection(
    running: _RunningWebSocket,
    *,
    from_client: bool,
) -> connection.Connection:
    return running.client if from_client else running.server


def _message_hooks(observed: list[commands.Command]) -> list[websocket.WebsocketMessageHook]:
    return [command for command in observed if isinstance(command, websocket.WebsocketMessageHook)]


def _data_sends(observed: list[commands.Command]) -> list[commands.SendData]:
    return [
        command
        for command in observed
        if isinstance(command, commands.SendData) and command.data[0] & 0x0F != 0x08
    ]


@pytest.mark.parametrize(
    ("from_client", "content"),
    [
        (True, b"client-binary"),
        (False, "server-text"),
    ],
)
async def test_decoded_message_limit_applies_to_both_directions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
    content: bytes | str,
) -> None:
    encoded_size = len(content.encode() if isinstance(content, str) else content)
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", encoded_size)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context)
        peer = _peer(from_client=from_client)

        accepted = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(content)),
            ),
        )
        rejected = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(b"x" * (encoded_size + 1))),
            ),
        )

    assert len(_message_hooks(accepted)) == 1
    assert len(_data_sends(accepted)) == 1
    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == [
        content.encode() if isinstance(content, str) else content
    ]
    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket.close_code == 1009
    assert not running.flow.live


async def test_read_split_message_reuses_mutable_fragment(
    tmp_path: Path,
) -> None:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context)
        wire = _peer(from_client=False).send(_message_event(b"split-across-reads"))

        await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[:6]),
        )
        fragment = running.layer.server_ws.frame_buf[-1]
        first_identity = id(fragment)
        assert isinstance(fragment, bytearray)

        await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[6:12]),
        )
        assert id(running.layer.server_ws.frame_buf[-1]) == first_identity

        completed = await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[12:]),
        )

    assert len(_message_hooks(completed)) == 1
    assert running.flow.websocket is not None
    assert running.flow.websocket.messages[-1].content == b"split-across-reads"


async def test_fragmented_message_limits_ignore_interleaved_control_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 2)
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 2)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        accepted = await _start_websocket(addon_context)
        accepted_peer = _peer(from_client=False)
        first = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                accepted.server,
                accepted_peer.send(_message_event(b"a", message_finished=False)),
            ),
        )
        ping = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                accepted.server,
                accepted_peer.send(wsproto.events.Ping(payload=b"still-open")),
            ),
        )
        final = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(accepted.server, accepted_peer.send(_message_event(b"b"))),
        )

        rejected = await _start_websocket(addon_context)
        rejected_peer = _peer(from_client=False)
        for _ in range(2):
            observed = await _handle_event(
                addon_context,
                rejected,
                events.DataReceived(
                    rejected.server,
                    rejected_peer.send(_message_event(b"", message_finished=False)),
                ),
            )
            assert _message_hooks(observed) == []
        over_limit = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(rejected.server, rejected_peer.send(_message_event(b""))),
        )

        byte_rejected = await _start_websocket(addon_context)
        byte_rejected_peer = _peer(from_client=False)
        byte_prefix = await _handle_event(
            addon_context,
            byte_rejected,
            events.DataReceived(
                byte_rejected.server,
                byte_rejected_peer.send(_message_event(b"a", message_finished=False)),
            ),
        )
        byte_over_limit = await _handle_event(
            addon_context,
            byte_rejected,
            events.DataReceived(
                byte_rejected.server,
                byte_rejected_peer.send(_message_event(b"bb")),
            ),
        )

    assert first == []
    assert any(isinstance(command, commands.SendData) for command in ping)
    assert len(_message_hooks(final)) == 1
    assert accepted.flow.websocket is not None
    assert accepted.flow.websocket.messages[-1].content == b"ab"
    assert _message_hooks(over_limit) == []
    assert _data_sends(over_limit) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert rejected.flow.websocket.messages == []
    assert byte_prefix == []
    assert _message_hooks(byte_over_limit) == []
    assert _data_sends(byte_over_limit) == []
    assert byte_rejected.flow.websocket is not None
    assert byte_rejected.flow.websocket.close_code == 1009
    assert byte_rejected.flow.websocket.messages == []


async def test_compression_preserves_context_takeover_and_is_connection_local(
    tmp_path: Path,
) -> None:
    original_permessage_deflate = wsproto.extensions.PerMessageDeflate

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        peer = _peer(
            from_client=False,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        first = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                running.server,
                peer.send(_message_event(b"shared-prefix-" * 32)),
            ),
        )
        assert isinstance(
            running.layer.server_ws,
            websocket_framing._BoundedWebsocketConnection,
        )
        assert len(running.layer.server_ws._vm0_bounded_deflates) == 1
        bounded_deflate = running.layer.server_ws._vm0_bounded_deflates[0]
        first_decompressor = bounded_deflate._decompressor
        assert first_decompressor is not None

        second = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                running.server,
                peer.send(_message_event(b"shared-prefix-" * 32 + b"second")),
            ),
        )
        assert bounded_deflate._decompressor is first_decompressor

    assert wsproto.extensions.PerMessageDeflate is original_permessage_deflate
    assert len(_message_hooks(first)) == 1
    assert len(_message_hooks(second)) == 1
    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == [
        b"shared-prefix-" * 32,
        b"shared-prefix-" * 32 + b"second",
    ]


@pytest.mark.parametrize(
    ("from_client", "permessage_deflate"),
    [
        (True, f"{_PERMESSAGE_DEFLATE}; client_no_context_takeover"),
        (False, f"{_PERMESSAGE_DEFLATE}; server_no_context_takeover"),
    ],
)
async def test_compression_releases_negotiated_no_context_takeover_state(
    tmp_path: Path,
    from_client: bool,
    permessage_deflate: str,
) -> None:
    contents = [
        b"shared-prefix-" * 32,
        b"shared-prefix-" * 32 + b"second",
    ]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            permessage_deflate=permessage_deflate,
        )
        peer = _peer(
            from_client=from_client,
            permessage_deflate=permessage_deflate,
        )
        source_websocket = running.layer.client_ws if from_client else running.layer.server_ws
        assert isinstance(
            source_websocket,
            websocket_framing._BoundedWebsocketConnection,
        )
        assert len(source_websocket._vm0_bounded_deflates) == 1
        bounded_deflate = source_websocket._vm0_bounded_deflates[0]

        for content in contents:
            delivered = await _handle_event(
                addon_context,
                running,
                events.DataReceived(
                    _source_connection(running, from_client=from_client),
                    peer.send(_message_event(content)),
                ),
            )

            assert len(_message_hooks(delivered)) == 1
            assert len(_data_sends(delivered)) == 1
            assert running.flow.websocket is not None
            assert running.flow.websocket.messages[-1].content == content
            assert bounded_deflate._decompressor is None

    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == contents


@pytest.mark.parametrize("from_client", [True, False])
async def test_malformed_compressed_frame_closes_only_the_rejected_flow(
    tmp_path: Path,
    from_client: bool,
) -> None:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        rejected = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        malformed = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                _malformed_compressed_binary_frame(from_client=from_client),
            ),
        )

        healthy = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        healthy_peer = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                _source_connection(healthy, from_client=from_client),
                healthy_peer.send(_message_event(b"healthy-compressed")),
            ),
        )

    assert _message_hooks(malformed) == []
    assert _data_sends(malformed) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1007
    assert rejected.flow.websocket.messages == []
    assert not rejected.flow.live

    rejected_source = rejected.layer.client_ws if from_client else rejected.layer.server_ws
    assert isinstance(rejected_source, websocket_framing._BoundedWebsocketConnection)
    assert sum(len(fragment) for fragment in rejected_source.frame_buf) == 0
    assert len(rejected_source._vm0_bounded_deflates) == 1
    bounded_deflate = rejected_source._vm0_bounded_deflates[0]
    assert bounded_deflate._decompressor is None
    assert bounded_deflate._inbound_is_compressible is None
    assert bounded_deflate._inbound_compressed is None
    assert rejected_source._vm0_message_limit._budget.decoded_bytes == 0
    assert rejected_source._vm0_message_limit._budget.data_frames == 0

    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert healthy.flow.websocket is not None
    assert healthy.flow.websocket.timestamp_end is None
    assert healthy.flow.websocket.messages[-1].content == b"healthy-compressed"


@pytest.mark.parametrize("from_client", [True, False])
async def test_compressed_overflow_is_bounded_and_does_not_affect_another_flow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
) -> None:
    decoded_limit = 4 * 1024
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", decoded_limit)
    stats = _track_zlib_decompression(monkeypatch)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        rejected = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
            run_id="run-rejected",
        )
        compressed_peer = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        overflow = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                compressed_peer.send(_message_event(b"x" * (1024 * 1024))),
            ),
        )

        healthy = await _start_websocket(addon_context, run_id="run-healthy")
        healthy_peer = _peer(from_client=False)
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                healthy.server,
                healthy_peer.send(_message_event(b"healthy")),
            ),
        )

    assert stats.max_lengths
    assert all(0 < max_length <= decoded_limit + 1 for max_length in stats.max_lengths)
    assert max(stats.output_sizes) <= decoded_limit + 1
    assert all(instance() is None for instance in stats.instances)
    assert _message_hooks(overflow) == []
    assert _data_sends(overflow) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert rejected.flow.websocket.messages == []
    rejected_source = rejected.layer.client_ws if from_client else rejected.layer.server_ws
    assert sum(len(fragment) for fragment in rejected_source.frame_buf) == 0
    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert healthy.flow.websocket is not None
    assert healthy.flow.websocket.timestamp_end is None
    assert healthy.flow.websocket.messages[-1].content == b"healthy"
