"""Helpers for connector diagnostic hook lifecycle tests."""

from pathlib import Path

from mitmproxy import http

import mitm_addon
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry

CONNECTOR_DIAGNOSTIC_REQUEST_CHUNK = b"partial request"


def write_connector_diagnostic_capture_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(
            tmp_path,
            vm_fields={"captureNetworkBodies": True},
        ),
    )


def record_connector_diagnostic_requestheaders_context(
    flow: http.HTTPFlow,
    *,
    request_chunk: bytes = CONNECTOR_DIAGNOSTIC_REQUEST_CHUNK,
) -> bytes:
    result = mitm_addon.requestheaders(flow)
    assert result is None
    stream = flow.request.stream
    assert callable(stream)
    assert stream(request_chunk) == request_chunk
    return request_chunk
