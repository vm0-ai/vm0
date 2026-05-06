"""Model usage_event token categories shared by extraction and reporting."""

MODEL_USAGE_CATEGORY_INPUT = "tokens.input"
MODEL_USAGE_CATEGORY_OUTPUT = "tokens.output"
MODEL_USAGE_CATEGORY_CACHE_READ = "tokens.cache_read"
MODEL_USAGE_CATEGORY_CACHE_CREATION = "tokens.cache_creation"

ANTHROPIC_USAGE_FIELD_CATEGORIES = {
    "input_tokens": MODEL_USAGE_CATEGORY_INPUT,
    "output_tokens": MODEL_USAGE_CATEGORY_OUTPUT,
    "cache_read_input_tokens": MODEL_USAGE_CATEGORY_CACHE_READ,
    "cache_creation_input_tokens": MODEL_USAGE_CATEGORY_CACHE_CREATION,
}

MODEL_USAGE_CATEGORIES = tuple(ANTHROPIC_USAGE_FIELD_CATEGORIES.values())
