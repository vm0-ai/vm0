-- Temporary old-writer/new-database bridge for #30349. Remove with #30351
-- only after the marker-writing API and its rollback window have drained and
-- production has no authoritative unmarked SocialKit MP4 rows.
CREATE OR REPLACE FUNCTION "mark_socialkit_mp4_artifact_1033"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."metadata" ->> 'generatedBy' = 'zero-official-video'
    OR NEW."run_id" IS NULL
    OR NEW."org_id" IS NULL
    OR NEW."content_type" IS DISTINCT FROM 'video/mp4'
    OR NEW."metadata" ->> 'provider' IS DISTINCT FROM 'socialkit'
  THEN
    RETURN NEW;
  END IF;

  IF NEW."external_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "socialkit_download_jobs" AS "job"
    WHERE "job"."id" = NEW."external_id"::uuid
      AND "job"."user_id" = NEW."user_id"
      AND "job"."org_id" = NEW."org_id"
      AND "job"."run_id" = NEW."run_id"
      AND "job"."provider_job_id" = NEW."metadata" ->> 'providerJobId'
      AND "job"."request" ->> 'format' = 'mp4'
  ) THEN
    NEW."metadata" := jsonb_set(
      NEW."metadata",
      '{generatedBy}',
      to_jsonb('zero-official-video'::text),
      true
    );
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "run_uploaded_files_mark_socialkit_mp4_1033" ON "run_uploaded_files";
--> statement-breakpoint
CREATE TRIGGER "run_uploaded_files_mark_socialkit_mp4_1033"
BEFORE INSERT OR UPDATE OF "external_id", "run_id", "user_id", "org_id", "content_type", "metadata"
ON "run_uploaded_files"
FOR EACH ROW
EXECUTE FUNCTION "mark_socialkit_mp4_artifact_1033"();
--> statement-breakpoint
UPDATE "run_uploaded_files" AS "file"
SET "metadata" = jsonb_set(
  "file"."metadata",
  '{generatedBy}',
  to_jsonb('zero-official-video'::text),
  true
)
FROM "socialkit_download_jobs" AS "job"
WHERE "job"."status" IN ('materializing', 'artifact_failed', 'completed')
  AND "job"."id"::text = "file"."external_id"
  AND "job"."user_id" = "file"."user_id"
  AND "job"."org_id" = "file"."org_id"
  AND "job"."run_id" = "file"."run_id"
  AND "job"."provider_job_id" = "file"."metadata" ->> 'providerJobId'
  AND "job"."request" ->> 'format' = 'mp4'
  AND "file"."run_id" IS NOT NULL
  AND "file"."org_id" IS NOT NULL
  AND "file"."content_type" = 'video/mp4'
  AND "file"."metadata" ->> 'provider' = 'socialkit'
  AND "file"."metadata" ->> 'generatedBy' IS DISTINCT FROM 'zero-official-video';
