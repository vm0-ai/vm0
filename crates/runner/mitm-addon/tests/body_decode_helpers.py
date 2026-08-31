"""Shared compression helpers for mitm-addon body decoding tests."""

import brotli


def track_brotli_decompressor(monkeypatch):
    real_decompressor = brotli.Decompressor
    stats = {
        "calls": 0,
        "max_input": 0,
        "max_output": 0,
        "max_output_buffer_limit": 0,
    }

    class CountingDecompressor:
        def __init__(self):
            self._inner = real_decompressor()

        def process(self, chunk: bytes, output_buffer_limit: int = 0) -> bytes:
            stats["calls"] += 1
            stats["max_input"] = max(stats["max_input"], len(chunk))
            stats["max_output_buffer_limit"] = max(
                stats["max_output_buffer_limit"],
                output_buffer_limit,
            )
            out = self._inner.process(chunk, output_buffer_limit=output_buffer_limit)
            stats["max_output"] = max(stats["max_output"], len(out))
            return out

        def is_finished(self) -> bool:
            return self._inner.is_finished()

        def can_accept_more_data(self) -> bool:
            return self._inner.can_accept_more_data()

    monkeypatch.setattr("body_decoding.brotli.Decompressor", CountingDecompressor)
    return stats


def pseudo_random_ascii(size: int) -> bytes:
    state = 0x12345678
    body = bytearray()
    for _ in range(size):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        body.append(32 + (state % 95))
    return bytes(body)
