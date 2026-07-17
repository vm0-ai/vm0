-- Mirror existing Moonshot Kimi K2.7 Code managed keys for Kimi K3.
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
  'kimi-k3',
  "source"."api_key",
  "source"."label",
  now(),
  now()
FROM "vm0_api_keys" AS "source"
WHERE "source"."vendor" = 'moonshot'
  AND "source"."model" = 'kimi-k2.7-code'
  AND NOT EXISTS (
    SELECT 1
    FROM "vm0_api_keys" AS "target"
    WHERE "target"."vendor" = 'moonshot'
      AND "target"."model" = 'kimi-k3'
      AND "target"."api_key" = "source"."api_key"
  );
