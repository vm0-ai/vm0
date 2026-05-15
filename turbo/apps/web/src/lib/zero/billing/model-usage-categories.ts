export const TOKEN_CATEGORY_INPUT = "tokens.input";
export const TOKEN_CATEGORY_OUTPUT = "tokens.output";
export const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
export const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

// Realtime Talker (OpenAI gpt-realtime-2) and input transcription
// (gpt-4o-mini-transcribe) provider/category constants. The Realtime relay
// emits per-modality token counts (text/audio/cached_*) instead of the four
// flat buckets used by chat-completion-style models, so they need their own
// category set. Usage reporting rolls these into the flat buckets.
export const REALTIME_PROVIDER = "gpt-realtime-2";
export const TRANSCRIPTION_PROVIDER = "gpt-4o-mini-transcribe";

export const REALTIME_TOKEN_CATEGORIES = [
  "tokens.input.text",
  "tokens.input.audio",
  "tokens.input.cached_text",
  "tokens.input.cached_audio",
  "tokens.output.text",
  "tokens.output.audio",
] as const;

export const TRANSCRIPTION_TOKEN_CATEGORIES = [
  "tokens.input.audio",
  "tokens.input.text",
  "tokens.output.text",
] as const;
