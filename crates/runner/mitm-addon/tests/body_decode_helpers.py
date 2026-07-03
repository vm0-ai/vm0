"""Shared compression helpers for mitm-addon body decoding tests."""

from dataclasses import dataclass, field

import brotli
import zstandard


@dataclass
class ZstdDecompressStats:
    calls: int = 0
    decompressobj_calls: int = 0
    max_input: int = 0
    max_output: int = 0
    input_sizes: list[int] = field(default_factory=list, repr=False)
    output_sizes: list[int] = field(default_factory=list, repr=False)


def track_brotli_decompressor(monkeypatch):
    real_decompressor = brotli.Decompressor
    stats = {"calls": 0, "max_input": 0, "max_output": 0}

    class CountingDecompressor:
        def __init__(self):
            self._inner = real_decompressor()

        def process(self, chunk: bytes) -> bytes:
            out = self._inner.process(chunk)
            stats["calls"] += 1
            stats["max_input"] = max(stats["max_input"], len(chunk))
            stats["max_output"] = max(stats["max_output"], len(out))
            return out

        def is_finished(self) -> bool:
            return self._inner.is_finished()

    monkeypatch.setattr("body_decoding.brotli.Decompressor", CountingDecompressor)
    return stats


def track_zstd_decompressor(monkeypatch) -> ZstdDecompressStats:
    real_decompressor = zstandard.ZstdDecompressor
    stats = ZstdDecompressStats()

    class CountingDecompressionObj:
        def __init__(self, inner):
            self._inner = inner

        def decompress(self, chunk: bytes) -> bytes:
            stats.calls += 1
            stats.input_sizes.append(len(chunk))
            stats.max_input = max(stats.max_input, len(chunk))
            try:
                decoded = self._inner.decompress(chunk)
            except zstandard.ZstdError:
                stats.output_sizes.append(0)
                raise
            stats.output_sizes.append(len(decoded))
            stats.max_output = max(stats.max_output, len(decoded))
            return decoded

        @property
        def eof(self):
            return self._inner.eof

        @property
        def unused_data(self):
            return self._inner.unused_data

        @property
        def unconsumed_tail(self):
            return self._inner.unconsumed_tail

    class CountingZstdDecompressor:
        def __init__(self, *args, **kwargs):
            self._inner = real_decompressor(*args, **kwargs)

        def decompressobj(self, *args, **kwargs):
            stats.decompressobj_calls += 1
            return CountingDecompressionObj(self._inner.decompressobj(*args, **kwargs))

    monkeypatch.setattr("body_decoding.zstandard.ZstdDecompressor", CountingZstdDecompressor)
    return stats


def pseudo_random_ascii(size: int) -> bytes:
    state = 0x12345678
    body = bytearray()
    for _ in range(size):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        body.append(32 + (state % 95))
    return bytes(body)
