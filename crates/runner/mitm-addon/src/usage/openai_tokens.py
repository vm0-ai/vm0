"""Shared OpenAI-compatible token normalization."""

from typing import TypeGuard


def is_usage_quantity(value: object) -> TypeGuard[int]:
    """Return whether a provider value is a nonnegative integer token count."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def partition_input_tokens(
    input_tokens: object,
    cached_tokens: object,
    cache_write_tokens: object,
) -> tuple[int | None, int | None, int | None]:
    """Partition an OpenAI-compatible total input count into billing categories."""
    if not is_usage_quantity(input_tokens):
        return None, None, None

    remaining_input_tokens = input_tokens
    cached_input_tokens = None
    if is_usage_quantity(cached_tokens):
        cached_input_tokens = min(cached_tokens, remaining_input_tokens)
        remaining_input_tokens -= cached_input_tokens

    cache_creation_tokens = None
    if is_usage_quantity(cache_write_tokens):
        cache_creation_tokens = min(cache_write_tokens, remaining_input_tokens)
        remaining_input_tokens -= cache_creation_tokens

    return remaining_input_tokens, cached_input_tokens, cache_creation_tokens
