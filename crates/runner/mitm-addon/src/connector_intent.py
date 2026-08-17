"""Private connector-routing intent capture for mitmproxy HTTP flows."""

from dataclasses import dataclass
from typing import Final, Literal

from mitmproxy import http

HEADER_NAME: Final = "X-VM0-Connector-Intent"

_RAW_HEADER_NAME: Final = b"x-vm0-connector-intent"
_MAX_CONNECTOR_INTENT_BYTES: Final = 64

_VALUE_METADATA_KEY = "_connector_intent_value"
_STATUS_METADATA_KEY = "_connector_intent_status"

REQUEST_HEADERS_PROBE_METADATA_KEYS = (
    _VALUE_METADATA_KEY,
    _STATUS_METADATA_KEY,
)

ConnectorIntentStatus = Literal["absent", "malformed", "present"]


@dataclass(frozen=True, slots=True)
class ConnectorIntent:
    """Parsed connector-routing intent captured from one private header."""

    status: ConnectorIntentStatus
    value: str | None = None


ABSENT = ConnectorIntent("absent")
MALFORMED = ConnectorIntent("malformed")


def capture_and_strip(flow: http.HTTPFlow) -> None:
    """Capture connector intent once and always remove its private header."""
    if _STATUS_METADATA_KEY not in flow.metadata:
        raw_value: bytes | None = None
        repeated = False
        for name, value in flow.request.headers.fields:
            if name.lower() != _RAW_HEADER_NAME:
                continue
            if raw_value is not None:
                repeated = True
                break
            raw_value = value

        if raw_value is None:
            flow.metadata[_STATUS_METADATA_KEY] = "absent"
        elif repeated or len(raw_value) > _MAX_CONNECTOR_INTENT_BYTES:
            flow.metadata[_STATUS_METADATA_KEY] = "malformed"
        else:
            value = flow.request.headers.get_all(HEADER_NAME)[0].strip()
            if value == "" or "," in value:
                flow.metadata[_STATUS_METADATA_KEY] = "malformed"
            else:
                flow.metadata[_STATUS_METADATA_KEY] = "present"
                flow.metadata[_VALUE_METADATA_KEY] = value

    flow.request.headers.set_all(HEADER_NAME, [])


def from_flow(flow: http.HTTPFlow) -> ConnectorIntent:
    """Return the captured intent, defaulting to absent for uncaptured flows."""
    status = flow.metadata.get(_STATUS_METADATA_KEY)
    if status == "malformed":
        return MALFORMED
    if status == "present":
        value = flow.metadata.get(_VALUE_METADATA_KEY)
        if isinstance(value, str):
            return ConnectorIntent("present", value)
    return ABSENT
