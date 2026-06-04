"""Connector response parser result types."""

from collections.abc import Callable
from typing import NamedTuple


class ConnectorResponseParser(NamedTuple):
    """Incremental parser hooks for connector response-body usage extraction.

    Connector parser factories registered in ``_RESPONSE_PARSER_FACTORIES``
    return this value when a connector flow needs response-body parsing for
    connector usage extraction. The response streaming layer wires ``feed`` into
    the stream callback for that flow.

    ``feed`` receives each streamed response-body chunk. For ``gzip``,
    ``deflate``, and ``zstd``, the stream wrapper passes decompressed bytes to
    ``feed``. With no encoding or ``identity``, the original chunk bytes are
    passed through unchanged. Encodings that cannot be safely decoded with a
    bounded incremental output, including ``br`` and unsupported values, skip
    response-body parsing for that flow. Implementations must treat ``b""`` as
    a no-op: incremental decompressors may produce no output for a source
    chunk, and decompression failures intentionally suppress later parser input.

    ``finish`` is optional. When provided, normal completed-response
    finalization calls it once after streaming has fed all chunks and before
    ``report_connector_usage`` consumes connector metadata. It should publish
    final parser state to connector-owned ``flow.metadata`` keys through the
    closure created by the connector parser factory. Cleanup and connection
    error paths can release unfinished parser state without finalizing it, so
    parser correctness must not rely on ``finish`` running for every interrupted
    response.
    """

    feed: Callable[[bytes], None]
    finish: Callable[[], None] | None = None
