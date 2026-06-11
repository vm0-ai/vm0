"""Shared body size limits for mitm-addon buffering and decoding."""

# Cap for non-model-provider response body buffering and decompression output.
STREAM_BUFFER_LIMIT = 64 * 1024  # 64 KB

# Maximum decoded chunk size fed to incremental usage parsers. This bounds
# transient decompressor output without truncating the total response scanned by
# bounded-state parsers.
STREAM_DECODE_CHUNK_LIMIT = 64 * 1024  # 64 KB

# Decompression cap for production model-provider and connector JSON usage
# fallback paths. Keep this larger than STREAM_BUFFER_LIMIT so diagnostic
# and silent usage fallbacks can parse complete usage payloads while still
# bounding decompression bombs.
LARGE_RESPONSE_DECOMPRESS_LIMIT = 5 * 1024 * 1024  # 5 MB
