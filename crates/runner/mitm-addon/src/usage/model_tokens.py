"""Normalized model token categories shared by provider extractors.

Extractors write only the base categories in ``MODEL_USAGE_CATEGORIES``.
Model-provider reporting may remap those keys to reporter-owned billing
categories after selecting a tier.
"""

from .quantities import is_usage_quantity

MODEL_USAGE_CATEGORY_INPUT = "tokens.input"
MODEL_USAGE_CATEGORY_OUTPUT = "tokens.output"
MODEL_USAGE_CATEGORY_CACHE_READ = "tokens.cache_read"
MODEL_USAGE_CATEGORY_CACHE_CREATION = "tokens.cache_creation"

# Canonical normalized category keys accepted from provider extractors.
MODEL_USAGE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
)


def update_model_usage_quantity(target: dict, category: str, value: object) -> None:
    """Apply a positive-wins model usage update to one normalized category.

    Provider updates may report zero after an earlier positive quantity. Preserve
    the recorded value in that case, while retaining zero for a missing category.
    """
    if is_usage_quantity(value) and (value > 0 or category not in target):
        target[category] = value


ANTHROPIC_USAGE_FIELD_CATEGORIES = {
    "input_tokens": MODEL_USAGE_CATEGORY_INPUT,
    "output_tokens": MODEL_USAGE_CATEGORY_OUTPUT,
    "cache_read_input_tokens": MODEL_USAGE_CATEGORY_CACHE_READ,
    "cache_creation_input_tokens": MODEL_USAGE_CATEGORY_CACHE_CREATION,
}
