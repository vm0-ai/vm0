"""Model token usage categories shared by extraction and reporting."""

MODEL_USAGE_CATEGORY_INPUT = "tokens.input"
MODEL_USAGE_CATEGORY_OUTPUT = "tokens.output"
MODEL_USAGE_CATEGORY_CACHE_READ = "tokens.cache_read"
MODEL_USAGE_CATEGORY_CACHE_CREATION = "tokens.cache_creation"
MODEL_USAGE_CATEGORY_INPUT_LONG_CONTEXT = "tokens.input.long_context"
MODEL_USAGE_CATEGORY_OUTPUT_LONG_CONTEXT = "tokens.output.long_context"
MODEL_USAGE_CATEGORY_CACHE_READ_LONG_CONTEXT = "tokens.cache_read.long_context"
MODEL_USAGE_CATEGORY_CACHE_CREATION_LONG_CONTEXT = "tokens.cache_creation.long_context"

ANTHROPIC_USAGE_FIELD_CATEGORIES = {
    "input_tokens": MODEL_USAGE_CATEGORY_INPUT,
    "output_tokens": MODEL_USAGE_CATEGORY_OUTPUT,
    "cache_read_input_tokens": MODEL_USAGE_CATEGORY_CACHE_READ,
    "cache_creation_input_tokens": MODEL_USAGE_CATEGORY_CACHE_CREATION,
}

MODEL_USAGE_CATEGORIES = tuple(ANTHROPIC_USAGE_FIELD_CATEGORIES.values())
