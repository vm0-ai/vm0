UPDATE "org_custom_connectors" AS target
SET "slug" = CASE
  WHEN length(target."slug") <= 63
    AND NOT EXISTS (
      SELECT 1
      FROM "org_custom_connectors" AS existing
      WHERE existing."org_id" = target."org_id"
        AND existing."id" <> target."id"
        AND existing."slug" = '_' || target."slug"
    )
  THEN '_' || target."slug"
  ELSE '_' || left(target."slug", 26) || '-' || target."id"::text
END
WHERE left(target."slug", 1) <> '_';
