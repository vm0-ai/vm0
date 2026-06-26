"""Shared body size limits for mitm-addon buffering and decoding."""

# Small bounded-body cap shared by stream buffers, persisted capture fields,
# default small decode output, and request-body billing inspection.
#
# These aliases intentionally share one value today. Keep them separate at call
# sites so future changes can review each semantic contract explicitly instead
# of treating every 64 KB body limit as interchangeable.
_SMALL_BODY_LIMIT_BYTES = 64 * 1024  # 64 KB

# Cap for request and response stream buffers. Stream-buffered request-body
# billing inspection depends on this cap for complete, untruncated bodies, so do
# not raise its inspection cap independently without also changing that source.
STREAM_BUFFER_LIMIT = _SMALL_BODY_LIMIT_BYTES

# Cap for request and response bodies persisted into network-log capture fields.
BODY_CAPTURE_LIMIT = _SMALL_BODY_LIMIT_BYTES

# Default cap for small bounded body decompression helpers.
DEFAULT_BODY_DECODE_LIMIT = _SMALL_BODY_LIMIT_BYTES

# Cap for connector request-body billing inspection. This is intentionally tied
# to STREAM_BUFFER_LIMIT while stream-buffered billing refinement reads complete
# bodies from request stream buffers.
REQUEST_BODY_BILLING_INSPECTION_LIMIT = _SMALL_BODY_LIMIT_BYTES

# Maximum decoded chunk size fed to incremental usage parsers. This bounds
# transient decompressor output without truncating the total response scanned by
# bounded-state parsers.
STREAM_DECODE_CHUNK_LIMIT = 64 * 1024  # 64 KB

# Decompression cap for production model-provider and connector JSON usage
# fallback paths. Keep this larger than STREAM_BUFFER_LIMIT so diagnostic
# and silent usage fallbacks can parse complete usage payloads while still
# bounding decompression bombs.
LARGE_RESPONSE_DECOMPRESS_LIMIT = 5 * 1024 * 1024  # 5 MB
