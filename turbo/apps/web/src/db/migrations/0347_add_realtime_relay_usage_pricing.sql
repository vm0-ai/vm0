-- Realtime Talker (gpt-realtime-2) and input transcription (gpt-4o-mini-transcribe)
-- usage pricing rows. unit_size = 1_000_000 tokens.
--
-- unit_price values are PLACEHOLDERS pending product/business sign-off.
-- This migration MUST NOT be merged with placeholder values; downstream
-- sub-issues fail closed (503 NOT_CONFIGURED) when any required category
-- is missing, so leaving the rows at 0 would silently bill no credits for
-- Realtime usage in production.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('model', 'gpt-realtime-2', 'tokens.input.text',          0, 1000000),
  ('model', 'gpt-realtime-2', 'tokens.input.audio',         0, 1000000),
  ('model', 'gpt-realtime-2', 'tokens.input.cached_text',   0, 1000000),
  ('model', 'gpt-realtime-2', 'tokens.input.cached_audio',  0, 1000000),
  ('model', 'gpt-realtime-2', 'tokens.output.text',         0, 1000000),
  ('model', 'gpt-realtime-2', 'tokens.output.audio',        0, 1000000),
  ('model', 'gpt-4o-mini-transcribe', 'tokens.input.audio', 0, 1000000),
  ('model', 'gpt-4o-mini-transcribe', 'tokens.input.text',  0, 1000000),
  ('model', 'gpt-4o-mini-transcribe', 'tokens.output.text', 0, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size"  = EXCLUDED."unit_size",
  "updated_at" = now();
