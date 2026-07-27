-- Ordinary media uploads were initially classified as `file` because the
-- catalog only looked at generatedBy. Reuse the same content-type boundary as
-- the catalog writer and attach those files to their media entities.

INSERT INTO "image_artifacts" ("file_id", "model", "provider")
SELECT DISTINCT
  file."id",
  file."metadata" ->> 'model',
  file."metadata" ->> 'provider'
FROM "artifacts" AS artifact
INNER JOIN "run_uploaded_files" AS file
  ON file."id" = artifact."projection_file_id"
WHERE artifact."kind" = 'file'
  AND (
    lower(split_part(coalesce(file."content_type", ''), ';', 1)) LIKE 'image/%'
    OR lower(coalesce(file."filename", file."external_id"))
      ~ '\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$'
  )
ON CONFLICT ("file_id") DO UPDATE
SET
  "model" = EXCLUDED."model",
  "provider" = EXCLUDED."provider",
  "updated_at" = now();
--> statement-breakpoint

INSERT INTO "video_artifacts" ("file_id", "model", "duration_seconds")
SELECT DISTINCT
  file."id",
  file."metadata" ->> 'model',
  CASE
    WHEN jsonb_typeof(file."metadata" -> 'durationSeconds') = 'number'
      THEN round((file."metadata" ->> 'durationSeconds')::numeric)::integer
    ELSE NULL
  END
FROM "artifacts" AS artifact
INNER JOIN "run_uploaded_files" AS file
  ON file."id" = artifact."projection_file_id"
WHERE artifact."kind" = 'file'
  AND (
    lower(split_part(coalesce(file."content_type", ''), ';', 1)) LIKE 'video/%'
    OR lower(coalesce(file."filename", file."external_id"))
      ~ '\.(m4v|mov|mp4|ogv|webm)$'
  )
ON CONFLICT ("file_id") DO UPDATE
SET
  "model" = EXCLUDED."model",
  "duration_seconds" = EXCLUDED."duration_seconds",
  "updated_at" = now();
--> statement-breakpoint

UPDATE "artifacts" AS artifact
SET
  "kind" = 'image',
  "entity_id" = image."id",
  "thumbnail" = COALESCE(
    artifact."thumbnail",
    CASE
      WHEN file."preview_image_url" IS NOT NULL
        THEN jsonb_build_object('url', file."preview_image_url")
      WHEN file."url" IS NOT NULL
        THEN jsonb_build_object('url', file."url")
      ELSE NULL
    END
  ),
  "updated_at" = now()
FROM "run_uploaded_files" AS file
INNER JOIN "image_artifacts" AS image
  ON image."file_id" = file."id"
WHERE artifact."kind" = 'file'
  AND artifact."projection_file_id" = file."id"
  AND (
    lower(split_part(coalesce(file."content_type", ''), ';', 1)) LIKE 'image/%'
    OR lower(coalesce(file."filename", file."external_id"))
      ~ '\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$'
  );
--> statement-breakpoint

UPDATE "artifacts" AS artifact
SET
  "kind" = 'video',
  "entity_id" = video."id",
  "thumbnail" = COALESCE(
    artifact."thumbnail",
    CASE
      WHEN file."preview_image_url" IS NOT NULL
        THEN jsonb_build_object('url', file."preview_image_url")
      ELSE NULL
    END
  ),
  "updated_at" = now()
FROM "run_uploaded_files" AS file
INNER JOIN "video_artifacts" AS video
  ON video."file_id" = file."id"
WHERE artifact."kind" = 'file'
  AND artifact."projection_file_id" = file."id"
  AND (
    lower(split_part(coalesce(file."content_type", ''), ';', 1)) LIKE 'video/%'
    OR lower(coalesce(file."filename", file."external_id"))
      ~ '\.(m4v|mov|mp4|ogv|webm)$'
  );
