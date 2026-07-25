-- Backfill the artifact catalog from the visible artifact history.
--
-- The legacy artifact list derives its rows from `run_uploaded_files` and hides
-- two classes of rows at query time: ordinary uploads produced by a run that
-- also published a hosted artifact, and repeated projections of the same URL.
-- Those collapses happen here instead, so one logical product becomes exactly
-- one `artifacts` row.
--
-- Hosted sites merge by `metadata.siteId`, so every deployment version of a
-- site shares a single artifact whose `created_at` is the site's creation time.
-- The catalog therefore holds fewer rows than the legacy list.
--
-- Every statement is idempotent: re-running the migration inserts nothing new
-- and never rewrites an artifact's list position.

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
  );
--> statement-breakpoint

-- Ordinary uploads and officially generated media. Repeated projections of the
-- same URL keep only their newest row.
CREATE TEMP TABLE vm0_artifact_catalog_file_plan ON COMMIT DROP AS
SELECT DISTINCT ON (file."org_id", file.author_user_id, file."url")
  file."id" AS file_id,
  file."org_id",
  file.author_user_id,
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
  file."id" DESC;
--> statement-breakpoint

-- Hosted sites and presentations collapse onto their site. The newest
-- projection supplies the preview image and the owning user.
CREATE TEMP TABLE vm0_artifact_catalog_hosted_plan ON COMMIT DROP AS
SELECT DISTINCT ON (site."id")
  site."id" AS hosted_site_id,
  file."org_id",
  file.author_user_id,
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
  site."created_at"
FROM pg_temp.vm0_artifact_catalog_visible_files AS file
INNER JOIN "hosted_sites" AS site
  ON site."id" = (file."metadata" ->> 'siteId')::uuid
WHERE file."metadata" ->> 'artifactKind'
  IN ('hosted-site', 'presentation-html')
ORDER BY
  site."id",
  file."created_at" DESC,
  file."id" DESC;
--> statement-breakpoint

INSERT INTO "image_artifacts" ("file_id", "model", "provider")
SELECT plan.file_id, plan.model, plan.provider
FROM pg_temp.vm0_artifact_catalog_file_plan AS plan
WHERE plan.kind = 'image'
ON CONFLICT ("file_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "video_artifacts" ("file_id", "model", "duration_seconds")
SELECT plan.file_id, plan.model, plan.duration_seconds
FROM pg_temp.vm0_artifact_catalog_file_plan AS plan
WHERE plan.kind = 'video'
ON CONFLICT ("file_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "presentation_artifacts" ("hosted_site_id")
SELECT plan.hosted_site_id
FROM pg_temp.vm0_artifact_catalog_hosted_plan AS plan
WHERE plan.kind = 'presentation'
ON CONFLICT ("hosted_site_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "artifacts" (
  "org_id",
  "author_user_id",
  "kind",
  "entity_id",
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
ON CONFLICT ("kind", "entity_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "artifacts" (
  "org_id",
  "author_user_id",
  "kind",
  "entity_id",
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
  plan.title,
  plan.thumbnail,
  plan."created_at",
  plan."created_at"
FROM pg_temp.vm0_artifact_catalog_hosted_plan AS plan
LEFT JOIN "presentation_artifacts" AS presentation_entity
  ON plan.kind = 'presentation'
  AND presentation_entity."hosted_site_id" = plan.hosted_site_id
WHERE plan.kind = 'hosted-site'
  OR presentation_entity."id" IS NOT NULL
ON CONFLICT ("kind", "entity_id") DO NOTHING;
--> statement-breakpoint

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
$$;
