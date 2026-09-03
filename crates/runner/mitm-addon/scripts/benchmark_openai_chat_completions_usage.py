"""Benchmark Chat Completions full extraction and bounded SSE fast paths."""

import sys
from collections.abc import Callable
from statistics import median
from time import perf_counter

from usage.openai_chat_completions import (
    _is_canonical_usage_free_delta,
    _new_extractor,
    create_openai_chat_completions_sse_usage_extractor,
)

_CYCLES = 10_000
_REPEATS = 5
_PAYLOAD = (
    b'{"id":"chatcmpl_1","object":"chat.completion.chunk",'
    b'"choices":[{"index":0,"delta":{"content":"x"}}]}'
)
_SSE_EVENT = b"data: " + _PAYLOAD + b"\n\n"
_REUSED_EXTRACTOR = _new_extractor()
_FAST_PATH_SCANNER, _ = create_openai_chat_completions_sse_usage_extractor()


def _fresh_cycle() -> None:
    extractor = _new_extractor()
    extractor.feed(_PAYLOAD)
    extractor.finish()


def _reused_cycle() -> None:
    _REUSED_EXTRACTOR.reset()
    _REUSED_EXTRACTOR.feed(_PAYLOAD)
    _REUSED_EXTRACTOR.finish()


def _bounded_classification_cycle() -> None:
    _is_canonical_usage_free_delta(_PAYLOAD)


def _fast_path_sse_cycle() -> None:
    _FAST_PATH_SCANNER(_SSE_EVENT)


def _median_duration(cycle: Callable[[], None]) -> float:
    durations: list[float] = []
    for _ in range(_REPEATS):
        started_at = perf_counter()
        for _ in range(_CYCLES):
            cycle()
        durations.append(perf_counter() - started_at)
    return median(durations)


def main() -> None:
    if not _is_canonical_usage_free_delta(_PAYLOAD):
        raise RuntimeError("benchmark payload did not enter the bounded fast path")
    fresh_duration = _median_duration(_fresh_cycle)
    reused_duration = _median_duration(_reused_cycle)
    classification_duration = _median_duration(_bounded_classification_cycle)
    sse_fast_path_duration = _median_duration(_fast_path_sse_cycle)
    sys.stdout.write(
        f"{_CYCLES:,} fresh construction/feed/finish cycles: {fresh_duration:.6f} s\n"
        f"{_CYCLES:,} reused reset/feed/finish cycles: {reused_duration:.6f} s\n"
        f"{_CYCLES:,} bounded decode/classify cycles: {classification_duration:.6f} s\n"
        f"{_CYCLES:,} complete SSE fast-path cycles: {sse_fast_path_duration:.6f} s\n"
        f"construction reuse speedup: {fresh_duration / reused_duration:.2f}x\n"
        f"reused full parse to bounded classification speedup: "
        f"{reused_duration / classification_duration:.2f}x\n"
        f"reused full parse to complete SSE fast-path speedup: "
        f"{reused_duration / sse_fast_path_duration:.2f}x\n"
    )


if __name__ == "__main__":
    main()
