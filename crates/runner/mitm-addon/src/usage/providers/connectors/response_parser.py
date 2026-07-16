"""Connector response parser result types."""

from collections.abc import Callable
from typing import NamedTuple


class ConnectorResponseParser(NamedTuple):
    """Incremental parser hooks for connector response-body usage extraction.

    Connector response-inspection capabilities registered in ``_REGISTRATIONS``
    return this value when a connector flow needs response-body parsing for
    connector usage extraction. The response streaming layer wires ``feed`` into
    the stream callback for that flow.

    ``feed`` receives each streamed response-body chunk. For ``gzip`` and
    ``deflate``, the stream wrapper passes decompressed bytes to ``feed``. With
    no encoding or ``identity``, the original chunk bytes are passed through
    unchanged. Encodings that cannot be safely decoded with a bounded
    incremental output, including ``br``, ``zstd``, and unsupported values, skip
    response-body parsing for that flow. Implementations must treat ``b""`` as a
    no-op: incremental decompressors may produce no output for a source chunk,
    and decompression failures intentionally suppress later parser input.

    ``report_on_interruption`` explicitly declares whether state accumulated by
    this parser may be finalized and reported after a connection error. Use it
    only when partial observations are independently billable; ordinary JSON
    parsers must leave it false so an incomplete body cannot reach request-side
    billing fallbacks.

    ``finish`` is optional. When provided, normal completed-response
    finalization calls it once after streaming has fed all chunks and before
    ``report_connector_usage`` consumes connector metadata. An interrupted
    response also calls it when ``report_on_interruption`` is true. It should
    publish final parser state to connector-owned ``flow.metadata`` keys through
    the closure created by the connector parser factory.

    ``finish_decode_error`` is optional. When provided, response streaming calls
    it instead of ``finish`` if the transport decoder cannot prove a compressed
    response body completed. It should publish connector-owned unparsed state so
    later fallback parsing does not trust best-effort decoded bytes. This runs
    before an opted-in interrupted response is reported.
    """

    feed: Callable[[bytes], None]
    report_on_interruption: bool
    finish: Callable[[], None] | None = None
    finish_decode_error: Callable[[str], None] | None = None
