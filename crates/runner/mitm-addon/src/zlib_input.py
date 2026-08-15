"""Bounded compressed-input traversal for zlib decoders."""

# Bound how much following compressed input zlib can copy into a member tail.
# One KiB prevents full-body tails while keeping a 64 KiB source to at most
# 64 fresh source slices.
_ZLIB_DECOMPRESS_INPUT_CHUNK_SIZE = 1024


class ZlibInputCursor:
    """Advance source bytes once while prioritizing bounded decompressor tails."""

    def __init__(self, data: bytes) -> None:
        self._source = memoryview(data)
        self._source_offset = 0
        self._pending_input = b""

    def __bool__(self) -> bool:
        return self._source_offset < len(self._source) or bool(self._pending_input)

    def take(self) -> bytes | memoryview:
        if self._pending_input:
            chunk = self._pending_input
            self._pending_input = b""
            return chunk
        chunk = self._source[
            self._source_offset : self._source_offset + _ZLIB_DECOMPRESS_INPUT_CHUNK_SIZE
        ]
        self._source_offset += len(chunk)
        return chunk

    def carry(self, data: bytes) -> None:
        self._pending_input = data
