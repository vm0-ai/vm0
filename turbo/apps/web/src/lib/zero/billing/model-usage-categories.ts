export const MODEL_USAGE_KIND = "model";
export const TOKEN_CATEGORY_INPUT = "tokens.input";
export const TOKEN_CATEGORY_OUTPUT = "tokens.output";
export const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
export const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

export const MODEL_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_CACHE_CREATION,
] as const;
