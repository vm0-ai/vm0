-- Queue every ready file written after the catalog tables exist. The previous
-- API version does not know how to dual-write `artifacts`, so this trigger is
-- the durable handoff across the migration-to-API promotion window.
CREATE FUNCTION "queue_artifact_catalog_file"() RETURNS trigger AS $$
DECLARE
  catalog_author_user_id text;
BEGIN
  IF NEW."url" IS NULL OR NEW."org_id" IS NULL THEN
    DELETE FROM "artifact_catalog_pending_files"
    WHERE "file_id" = NEW."id";
    RETURN NEW;
  END IF;

  catalog_author_user_id := COALESCE(
    (
      SELECT thread."user_id"
      FROM "chat_threads" AS thread
      WHERE thread."id" = COALESCE(
        NEW."chat_thread_id",
        (
          SELECT run."chat_thread_id"
          FROM "zero_runs" AS run
          WHERE run."id" = NEW."run_id"
        ),
        (
          SELECT message."chat_thread_id"
          FROM "chat_messages" AS message
          WHERE message."run_id" = NEW."run_id"
          ORDER BY message."seq_id" ASC
          LIMIT 1
        )
      )
    ),
    NEW."user_id"
  );

  INSERT INTO "artifact_catalog_pending_files" (
    "file_id",
    "org_id",
    "author_user_id",
    "queued_at"
  )
  VALUES (
    NEW."id",
    NEW."org_id",
    catalog_author_user_id,
    clock_timestamp()
  )
  ON CONFLICT ("file_id") DO UPDATE SET
    "org_id" = EXCLUDED."org_id",
    "author_user_id" = EXCLUDED."author_user_id",
    "queued_at" = EXCLUDED."queued_at";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "run_uploaded_files_queue_artifact_catalog"
AFTER INSERT OR UPDATE OF
  "run_id",
  "chat_thread_id",
  "user_id",
  "org_id",
  "external_id",
  "filename",
  "content_type",
  "url",
  "preview_image_url",
  "metadata"
ON "run_uploaded_files"
FOR EACH ROW EXECUTE FUNCTION "queue_artifact_catalog_file"();--> statement-breakpoint

-- Capture one fixed rollout boundary after the trigger is live. Rows that
-- commit later stay queued; rows inside this snapshot are handled by the
-- backfill below and removed from the pending handoff at the end.
CREATE TEMP TABLE vm0_artifact_catalog_backfill_context ON COMMIT DROP AS
SELECT clock_timestamp() AS captured_at;--> statement-breakpoint

CREATE TEMP TABLE vm0_artifact_catalog_rollout_file_ids ON COMMIT DROP AS
SELECT file."id"
FROM "run_uploaded_files" AS file;--> statement-breakpoint

-- Backfill the visible artifact history. The legacy list hides ordinary upload
-- shadows for hosted runs and collapses repeated projections of the same URL.
CREATE TEMP TABLE vm0_artifact_catalog_visible_files ON COMMIT DROP AS
SELECT
  file."id",
  file."org_id",
  file."url",
  file."filename",
  file."external_id",
  file."content_type",
  file."preview_image_url",
  file."metadata",
  file."created_at",
  COALESCE(
    (
      SELECT thread."user_id"
      FROM "chat_threads" AS thread
      WHERE thread."id" = COALESCE(
        file."chat_thread_id",
        (
          SELECT run."chat_thread_id"
          FROM "zero_runs" AS run
          WHERE run."id" = file."run_id"
        ),
        (
          SELECT message."chat_thread_id"
          FROM "chat_messages" AS message
          WHERE message."run_id" = file."run_id"
          ORDER BY message."seq_id" ASC
          LIMIT 1
        )
      )
    ),
    file."user_id"
  ) AS author_user_id
FROM "run_uploaded_files" AS file
INNER JOIN pg_temp.vm0_artifact_catalog_rollout_file_ids AS rollout
  ON rollout."id" = file."id"
WHERE file."url" IS NOT NULL
  AND file."org_id" IS NOT NULL
  AND (
    file."metadata" ->> 'artifactKind' IN ('hosted-site', 'presentation-html')
    OR NOT EXISTS (
      SELECT 1
      FROM "run_uploaded_files" AS hosted
      WHERE file."run_id" IS NOT NULL
        AND hosted."run_id" = file."run_id"
        AND hosted."metadata" ->> 'artifactKind'
          IN ('hosted-site', 'presentation-html')
    )
  );--> statement-breakpoint

-- One file URL is one logical product for an owner. The newest projection
-- supplies the kind entity and card metadata.
CREATE TEMP TABLE vm0_artifact_catalog_file_plan ON COMMIT DROP AS
SELECT DISTINCT ON (file."org_id", file.author_user_id, file."url")
  file."id" AS file_id,
  file."org_id",
  file.author_user_id,
  'file:' || file."url" AS logical_key,
  CASE file."metadata" ->> 'generatedBy'
    WHEN 'zero-official-image' THEN 'image'
    WHEN 'zero-official-video' THEN 'video'
    ELSE 'file'
  END AS kind,
  COALESCE(file."filename", file."external_id") AS title,
  CASE
    WHEN file."preview_image_url" IS NOT NULL
      THEN jsonb_build_object('url', file."preview_image_url")
    WHEN COALESCE(file."content_type", '') LIKE 'image/%'
      THEN jsonb_build_object('url', file."url")
    ELSE NULL
  END AS thumbnail,
  file."created_at",
  file."metadata" ->> 'model' AS model,
  file."metadata" ->> 'provider' AS provider,
  CASE
    WHEN jsonb_typeof(file."metadata" -> 'durationSeconds') = 'number'
      THEN round((file."metadata" ->> 'durationSeconds')::numeric)::integer
    ELSE NULL
  END AS duration_seconds
FROM pg_temp.vm0_artifact_catalog_visible_files AS file
WHERE file."metadata" ->> 'artifactKind' IS DISTINCT FROM 'hosted-site'
  AND file."metadata" ->> 'artifactKind' IS DISTINCT FROM 'presentation-html'
ORDER BY
  file."org_id",
  file.author_user_id,
  file."url",
  file."created_at" DESC,
  file."id" DESC;--> statement-breakpoint

-- Every deployment of one hosted site shares a logical product. The newest
-- projection decides whether that product is a site or presentation.
CREATE TEMP TABLE vm0_artifact_catalog_hosted_plan ON COMMIT DROP AS
SELECT DISTINCT ON (site."id")
  file."id" AS file_id,
  site."id" AS hosted_site_id,
  file."org_id",
  file.author_user_id,
  'site:' || site."id"::text AS logical_key,
  CASE file."metadata" ->> 'artifactKind'
    WHEN 'presentation-html' THEN 'presentation'
    ELSE 'hosted-site'
  END AS kind,
  site."slug" AS title,
  CASE
    WHEN file."preview_image_url" IS NOT NULL
      THEN jsonb_build_object('url', file."preview_image_url")
    ELSE NULL
  END AS thumbnail,
  site."created_at",
  file."created_at" AS projection_created_at
FROM pg_temp.vm0_artifact_catalog_visible_files AS file
INNER JOIN "hosted_sites" AS site
  ON site."id" = (file."metadata" ->> 'siteId')::uuid
WHERE file."metadata" ->> 'artifactKind'
  IN ('hosted-site', 'presentation-html')
ORDER BY
  site."id",
  file."created_at" DESC,
  file."id" DESC;--> statement-breakpoint

INSERT INTO "image_artifacts" ("file_id", "model", "provider")
SELECT plan.file_id, plan.model, plan.provider
FROM pg_temp.vm0_artifact_catalog_file_plan AS plan
WHERE plan.kind = 'image'
ON CONFLICT ("file_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "video_artifacts" ("file_id", "model", "duration_seconds")
SELECT plan.file_id, plan.model, plan.duration_seconds
FROM pg_temp.vm0_artifact_catalog_file_plan AS plan
WHERE plan.kind = 'video'
ON CONFLICT ("file_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "presentation_artifacts" ("hosted_site_id")
SELECT plan.hosted_site_id
FROM pg_temp.vm0_artifact_catalog_hosted_plan AS plan
WHERE plan.kind = 'presentation'
ON CONFLICT ("hosted_site_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "artifacts" (
  "org_id",
  "author_user_id",
  "kind",
  "entity_id",
  "logical_key",
  "projection_file_id",
  "projection_created_at",
  "title",
  "thumbnail",
  "created_at",
  "updated_at"
)
SELECT
  plan."org_id",
  plan.author_user_id,
  plan.kind,
  CASE plan.kind
    WHEN 'image' THEN image_entity."id"
    WHEN 'video' THEN video_entity."id"
    ELSE plan.file_id
  END,
  plan.logical_key,
  plan.file_id,
  plan."created_at",
  plan.title,
  plan.thumbnail,
  plan."created_at",
  plan."created_at"
FROM pg_temp.vm0_artifact_catalog_file_plan AS plan
LEFT JOIN "image_artifacts" AS image_entity
  ON plan.kind = 'image' AND image_entity."file_id" = plan.file_id
LEFT JOIN "video_artifacts" AS video_entity
  ON plan.kind = 'video' AND video_entity."file_id" = plan.file_id
WHERE plan.kind = 'file'
  OR image_entity."id" IS NOT NULL
  OR video_entity."id" IS NOT NULL
ON CONFLICT ("org_id", "author_user_id", "logical_key") DO UPDATE SET
  "kind" = EXCLUDED."kind",
  "entity_id" = EXCLUDED."entity_id",
  "projection_file_id" = EXCLUDED."projection_file_id",
  "projection_created_at" = EXCLUDED."projection_created_at",
  "title" = EXCLUDED."title",
  "thumbnail" = EXCLUDED."thumbnail",
  "updated_at" = EXCLUDED."updated_at"
WHERE (
  "artifacts"."projection_created_at",
  "artifacts"."projection_file_id"
) <= (
  EXCLUDED."projection_created_at",
  EXCLUDED."projection_file_id"
);--> statement-breakpoint

INSERT INTO "artifacts" (
  "org_id",
  "author_user_id",
  "kind",
  "entity_id",
  "logical_key",
  "projection_file_id",
  "projection_created_at",
  "title",
  "thumbnail",
  "created_at",
  "updated_at"
)
SELECT
  plan."org_id",
  plan.author_user_id,
  plan.kind,
  CASE plan.kind
    WHEN 'presentation' THEN presentation_entity."id"
    ELSE plan.hosted_site_id
  END,
  plan.logical_key,
  plan.file_id,
  plan.projection_created_at,
  plan.title,
  plan.thumbnail,
  plan."created_at",
  plan.projection_created_at
FROM pg_temp.vm0_artifact_catalog_hosted_plan AS plan
LEFT JOIN "presentation_artifacts" AS presentation_entity
  ON plan.kind = 'presentation'
  AND presentation_entity."hosted_site_id" = plan.hosted_site_id
WHERE plan.kind = 'hosted-site'
  OR presentation_entity."id" IS NOT NULL
ON CONFLICT ("org_id", "author_user_id", "logical_key") DO UPDATE SET
  "kind" = EXCLUDED."kind",
  "entity_id" = EXCLUDED."entity_id",
  "projection_file_id" = EXCLUDED."projection_file_id",
  "projection_created_at" = EXCLUDED."projection_created_at",
  "title" = EXCLUDED."title",
  "thumbnail" = EXCLUDED."thumbnail",
  "updated_at" = EXCLUDED."updated_at"
WHERE (
  "artifacts"."projection_created_at",
  "artifacts"."projection_file_id"
) <= (
  EXCLUDED."projection_created_at",
  EXCLUDED."projection_file_id"
);--> statement-breakpoint

DO $$
DECLARE
  planned_artifacts bigint;
  catalog_rows bigint;
  orphan_rows bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM pg_temp.vm0_artifact_catalog_file_plan)
    + (SELECT count(*) FROM pg_temp.vm0_artifact_catalog_hosted_plan)
  INTO planned_artifacts;

  SELECT count(*) INTO catalog_rows FROM "artifacts";

  SELECT count(*) INTO orphan_rows
  FROM "artifacts" AS artifact
  WHERE (
      artifact."kind" = 'file'
      AND NOT EXISTS (
        SELECT 1 FROM "run_uploaded_files" AS file
        WHERE file."id" = artifact."entity_id"
      )
    )
    OR (
      artifact."kind" = 'image'
      AND NOT EXISTS (
        SELECT 1 FROM "image_artifacts" AS entity
        WHERE entity."id" = artifact."entity_id"
      )
    )
    OR (
      artifact."kind" = 'video'
      AND NOT EXISTS (
        SELECT 1 FROM "video_artifacts" AS entity
        WHERE entity."id" = artifact."entity_id"
      )
    )
    OR (
      artifact."kind" = 'hosted-site'
      AND NOT EXISTS (
        SELECT 1 FROM "hosted_sites" AS site
        WHERE site."id" = artifact."entity_id"
      )
    )
    OR (
      artifact."kind" = 'presentation'
      AND NOT EXISTS (
        SELECT 1 FROM "presentation_artifacts" AS entity
        WHERE entity."id" = artifact."entity_id"
      )
    );

  IF orphan_rows > 0 THEN
    RAISE EXCEPTION
      'artifact catalog backfill produced % artifacts without a kind entity',
      orphan_rows
      USING ERRCODE = 'check_violation';
  END IF;

  IF catalog_rows < planned_artifacts THEN
    RAISE EXCEPTION
      'artifact catalog backfill planned % artifacts but the catalog holds %',
      planned_artifacts,
      catalog_rows
      USING ERRCODE = 'check_violation';
  END IF;

  RAISE NOTICE
    'artifact catalog backfill covered % artifacts',
    planned_artifacts;
END
$$;--> statement-breakpoint

-- Clear only queue entries covered by the fixed snapshot. A concurrent insert
-- or update receives a later `queued_at` and remains for the new API to drain.
DELETE FROM "artifact_catalog_pending_files" AS pending
USING
  pg_temp.vm0_artifact_catalog_rollout_file_ids AS rollout,
  pg_temp.vm0_artifact_catalog_backfill_context AS context
WHERE pending."file_id" = rollout."id"
  AND pending."queued_at" <= context.captured_at;
