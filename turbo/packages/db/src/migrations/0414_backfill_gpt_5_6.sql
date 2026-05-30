-- Introduce GPT-5.6 by mirroring GPT-5.5 (#15470).
--
-- 1. Website usage pricing: GPT-5.6 reuses GPT-5.5's per-token rates
--    ($5 / 1M input, $30 / 1M output) until real vendor pricing is known.
-- 2. Org model routes: every org that already has a GPT-5.5 policy gets an
--    equivalent GPT-5.6 policy on the SAME provider (default_provider_type,
--    credential_scope, model_provider_id are copied verbatim). The new policy
--    is never the org default (is_default = false) and existing defaults stay
--    untouched.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('website', 'gpt-5.6', 'tokens.input', 5000, 1000000),
  ('website', 'gpt-5.6', 'tokens.output', 30000, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();--> statement-breakpoint
INSERT INTO "org_model_policies" (
  "org_id",
  "model",
  "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "created_by_user_id",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "org_id",
  'gpt-5.6' AS "model",
  false AS "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "created_by_user_id",
  "updated_by_user_id",
  now(),
  now()
FROM "org_model_policies"
WHERE "model" = 'gpt-5.5'
ON CONFLICT ("org_id", "model") DO NOTHING;
