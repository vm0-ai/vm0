"""Version-locked bridges for mitmproxy state that public hooks omit."""

import wsproto
from mitmproxy import http, version
from mitmproxy.proxy import layer
from mitmproxy.proxy.layers.http import HttpStream
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook

import websocket_framing

# Keep this synchronized with ``crates/runner/src/deps.rs`` and the Python
# test dependencies. Re-audit the private imports, generators, and WebSocket
# extension behavior before accepting another version.
_SUPPORTED_MITMPROXY_VERSION = "12.2.3"
_SUPPORTED_WSPROTO_VERSION = "1.3.2"
_BRIDGE_MARKER_ATTRIBUTE = "_vm0_request_end_stream_bridge"
_REQUEST_END_STREAM_METADATA = "_vm0_request_end_stream"


def install_runtime_compatibility() -> None:
    """Install all exact-version mitmproxy compatibility adaptations."""
    if version.VERSION != _SUPPORTED_MITMPROXY_VERSION:
        raise RuntimeError(
            "VM0's runtime compatibility layer requires mitmproxy "
            f"{_SUPPORTED_MITMPROXY_VERSION}; found {version.VERSION}"
        )
    if wsproto.__version__ != _SUPPORTED_WSPROTO_VERSION:
        raise RuntimeError(
            "VM0's runtime compatibility layer requires wsproto "
            f"{_SUPPORTED_WSPROTO_VERSION}; found {wsproto.__version__}"
        )

    _install_request_end_stream_bridge()
    websocket_framing.install_websocket_framing()


def _install_request_end_stream_bridge() -> None:
    """Expose RequestHeaders.end_stream to the matching public hook once."""
    current_handler = HttpStream.state_wait_for_request_headers
    if hasattr(current_handler, _BRIDGE_MARKER_ATTRIBUTE):
        return

    def state_wait_for_request_headers(
        self: HttpStream,
        event: RequestHeaders,
    ) -> layer.CommandGenerator[None]:
        command_generator = current_handler(self, event)
        try:
            command = next(command_generator)
        except StopIteration:
            return

        while True:
            if isinstance(command, HttpRequestHeadersHook):
                command.flow.metadata[_REQUEST_END_STREAM_METADATA] = event.end_stream

            try:
                completion: object = yield command
            except GeneratorExit:
                command_generator.close()
                raise
            except BaseException as error:
                try:
                    command = command_generator.throw(error)
                except StopIteration:
                    return
            else:
                try:
                    command = command_generator.send(completion)
                except StopIteration:
                    return

    setattr(state_wait_for_request_headers, _BRIDGE_MARKER_ATTRIBUTE, True)
    HttpStream.state_wait_for_request_headers = state_wait_for_request_headers


def take_request_end_stream(flow: http.HTTPFlow) -> bool | None:
    """Consume the internal end-of-stream marker for one requestheaders hook."""
    value = flow.metadata.pop(_REQUEST_END_STREAM_METADATA, None)
    return value if isinstance(value, bool) else None
