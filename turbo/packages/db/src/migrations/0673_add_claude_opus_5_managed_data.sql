-- Mirror Claude Opus 4.8 managed pricing for Claude Opus 5.
INSERT INTO "usage_pricing" (
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
)
SELECT
  "source"."kind",
  'claude-opus-5',
  "source"."category",
  "source"."unit_price",
  "source"."unit_size"
FROM "usage_pricing" AS "source"
WHERE "source"."kind" = 'model'
  AND "source"."provider" = 'claude-opus-4-8'
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
--> statement-breakpoint
-- Mirror existing Anthropic Claude Opus 4.8 managed keys for Claude Opus 5.
INSERT INTO "vm0_api_keys" (
  "vendor",
  "model",
  "api_key",
  "label",
  "created_at",
  "updated_at"
)
SELECT
  "source"."vendor",
  'claude-opus-5',
  "source"."api_key",
  "source"."label",
  now(),
  now()
FROM "vm0_api_keys" AS "source"
WHERE "source"."vendor" = 'anthropic'
  AND "source"."model" = 'claude-opus-4-8'
  AND NOT EXISTS (
    SELECT 1
    FROM "vm0_api_keys" AS "target"
    WHERE "target"."vendor" = 'anthropic'
      AND "target"."model" = 'claude-opus-5'
      AND "target"."api_key" = "source"."api_key"
  );
