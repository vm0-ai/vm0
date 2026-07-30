DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "insights_daily" AS "insight"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof("insight"."data"->'permissions') = 'array'
          THEN "insight"."data"->'permissions'
        ELSE '[]'::jsonb
      END
    ) AS "permission"("value")
    WHERE jsonb_typeof("permission"."value") = 'object'
      AND jsonb_typeof("permission"."value"->'connectorSlug') = 'string'
      AND jsonb_typeof("permission"."value"->'connectorType') = 'string'
      AND "permission"."value"->>'connectorSlug'
        <> "permission"."value"->>'connectorType'
  ) THEN
    RAISE EXCEPTION
      'insights_daily permissions contain conflicting connectorSlug and connectorType identities';
  END IF;
END
$$;--> statement-breakpoint
UPDATE "insights_daily" AS "insight"
SET "data" = jsonb_set(
  "insight"."data",
  '{permissions}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof("permission"."value") <> 'object'
          THEN "permission"."value"
        WHEN jsonb_typeof("permission"."value"->'connectorType') = 'string'
          AND NOT ("permission"."value" ? 'connectorSlug')
          THEN (
            "permission"."value" || jsonb_build_object(
              'connectorSlug',
              "permission"."value"->'connectorType'
            )
          ) - 'connectorType'
        ELSE "permission"."value" - 'connectorType'
      END
      ORDER BY "permission"."ordinality"
    )
    FROM jsonb_array_elements(
      "insight"."data"->'permissions'
    ) WITH ORDINALITY AS "permission"("value", "ordinality")
  ),
  false
)
WHERE jsonb_typeof("insight"."data"->'permissions') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      "insight"."data"->'permissions'
    ) AS "permission"("value")
    WHERE jsonb_typeof("permission"."value") = 'object'
      AND "permission"."value" ? 'connectorType'
  );
