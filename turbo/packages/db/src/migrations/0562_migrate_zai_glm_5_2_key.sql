-- Mirror existing Z.AI GLM 5.1 managed keys for GLM 5.2.
-- This avoids relying on the runtime's vendor-level fallback when GLM 5.2 is
-- selected as a built-in model.

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
  'glm-5.2',
  "source"."api_key",
  "source"."label",
  now(),
  now()
FROM "vm0_api_keys" AS "source"
WHERE "source"."vendor" = 'zai'
  AND "source"."model" = 'glm-5.1'
  AND NOT EXISTS (
    SELECT 1
    FROM "vm0_api_keys" AS "target"
    WHERE "target"."vendor" = 'zai'
      AND "target"."model" = 'glm-5.2'
      AND "target"."api_key" = "source"."api_key"
  );
