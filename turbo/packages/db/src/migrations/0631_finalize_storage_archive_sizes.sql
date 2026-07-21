-- Freeze storage metadata so writers and old backfill requests cannot
-- change the candidate set while the migration validates it.
LOCK TABLE
  "storage_versions",
  "storages",
  "storage_archive_size_backfill_work"
IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- These tables hold operational references without foreign keys to storage
-- versions. Blocking writes keeps the reference classification stable until
-- the candidate deletes commit.
LOCK TABLE
  "agent_compose_versions",
  "agent_sessions",
  "agent_runs",
  "checkpoints",
  "runner_job_queue",
  "storage_version_lineage",
  "system_storage_presigned_url_cache"
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

CREATE TEMP TABLE "vm0_storage_archive_size_candidates" ON COMMIT DROP AS
SELECT
  storage_versions."id",
  storage_versions."storage_id",
  storage_versions."file_count",
  storage_versions."created_at",
  storages."org_id",
  storages."user_id",
  storages."name" AS "storage_name",
  storages."type" AS "storage_type",
  storage_archive_size_backfill_work."storage_version_id" AS "work_storage_version_id",
  storage_archive_size_backfill_work."lease_expires_at",
  storage_archive_size_backfill_work."outcome",
  storage_archive_size_backfill_work."error_code"
FROM "storage_versions"
INNER JOIN "storages"
  ON storages."id" = storage_versions."storage_id"
LEFT JOIN "storage_archive_size_backfill_work"
  ON storage_archive_size_backfill_work."storage_version_id" =
    storage_versions."id"
WHERE storage_versions."archive_size" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates"
    WHERE "file_count" <= 0
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found an empty or invalid null-size version';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates"
    WHERE "storage_type" NOT IN ('artifact', 'volume')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found an unhandled storage type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates"
    WHERE "created_at" >= TIMESTAMP '2025-12-22 07:33:04'
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a null-size version after the verified writer boundary';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates"
    WHERE "work_storage_version_id" IS NULL
      OR "outcome" IS DISTINCT FROM 'missing'
      OR "error_code" IS DISTINCT FROM 'archive-not-found'
      OR "lease_expires_at" > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found missing, in-flight, or non-terminal work evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "storage_archive_size_backfill_work" AS work
    LEFT JOIN "vm0_storage_archive_size_candidates" AS candidate
      ON candidate."id" = work."storage_version_id"
    WHERE candidate."id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found work outside the null candidate set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "storage_versions"
    WHERE "archive_size" < 0
      OR ("file_count" <> 0 AND "archive_size" = 0)
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found an invalid existing archive size';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "storages" AS referenced_storage
    INNER JOIN "vm0_storage_archive_size_candidates" AS candidate
      ON candidate."id" = referenced_storage."head_version_id"
    WHERE referenced_storage."id" <> candidate."storage_id"
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a cross-storage HEAD reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_compose_versions" AS compose_version
      ON TRUE
    CROSS JOIN LATERAL jsonb_each(
      CASE
        WHEN jsonb_typeof(compose_version."content" -> 'volumes') = 'object'
          THEN compose_version."content" -> 'volumes'
        ELSE '{}'::jsonb
      END
    ) AS volume(key, value)
    WHERE candidate."storage_type" = 'volume'
      AND candidate."storage_name" = volume.value ->> 'name'
      AND NULLIF(volume.value ->> 'version', '') IS NOT NULL
      AND left(
        candidate."id",
        length(volume.value ->> 'version')
      ) = lower(volume.value ->> 'version')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a compose volume reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_compose_versions" AS compose_version
      ON TRUE
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(compose_version."content" -> 'artifacts') = 'array'
          THEN compose_version."content" -> 'artifacts'
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE candidate."storage_type" = 'artifact'
      AND candidate."storage_name" = artifact.value ->> 'name'
      AND NULLIF(artifact.value ->> 'version', '') IS NOT NULL
      AND left(
        candidate."id",
        length(artifact.value ->> 'version')
      ) = lower(artifact.value ->> 'version')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a compose artifact reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_sessions" AS session
      ON session."org_id" = candidate."org_id"
      AND session."user_id" = candidate."user_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."artifacts") = 'array'
          THEN session."artifacts"
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE candidate."storage_type" = 'artifact'
      AND candidate."storage_name" = artifact.value ->> 'name'
      AND NULLIF(artifact.value ->> 'version', '') IS NOT NULL
      AND left(
        candidate."id",
        length(artifact.value ->> 'version')
      ) = lower(artifact.value ->> 'version')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a session artifact reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_runs" AS run
      ON run."org_id" = candidate."org_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(run."additional_volumes") = 'array'
          THEN run."additional_volumes"
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    WHERE candidate."storage_type" = 'volume'
      AND candidate."storage_name" = volume.value ->> 'name'
      AND NULLIF(volume.value ->> 'version', '') IS NOT NULL
      AND left(
        candidate."id",
        length(volume.value ->> 'version')
      ) = lower(volume.value ->> 'version')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a run additional-volume reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_runs" AS run
      ON run."org_id" = candidate."org_id"
    INNER JOIN "checkpoints" AS checkpoint
      ON checkpoint."run_id" = run."id"
    CROSS JOIN LATERAL jsonb_each_text(
      CASE
        WHEN jsonb_typeof(
          checkpoint."volume_versions_snapshot" -> 'versions'
        ) = 'object'
          THEN checkpoint."volume_versions_snapshot" -> 'versions'
        ELSE '{}'::jsonb
      END
    ) AS version(key, value)
    WHERE candidate."storage_type" = 'volume'
      AND candidate."storage_name" = version.key
      AND version.value <> ''
      AND left(candidate."id", length(version.value)) = lower(version.value)
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a checkpoint volume reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "agent_runs" AS run
      ON run."org_id" = candidate."org_id"
    INNER JOIN "checkpoints" AS checkpoint
      ON checkpoint."run_id" = run."id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          checkpoint."volume_versions_snapshot" -> 'additionalVolumes'
        ) = 'array'
          THEN checkpoint."volume_versions_snapshot" -> 'additionalVolumes'
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    WHERE candidate."storage_type" = 'volume'
      AND candidate."storage_name" = volume.value ->> 'name'
      AND NULLIF(volume.value ->> 'versionId', '') IS NOT NULL
      AND left(
        candidate."id",
        length(volume.value ->> 'versionId')
      ) = lower(volume.value ->> 'versionId')
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a checkpoint additional-volume reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "runner_job_queue" AS queue
    INNER JOIN "agent_runs" AS run
      ON run."id" = queue."run_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          queue."execution_context" -> 'storageManifest' -> 'storages'
        ) = 'array'
          THEN queue."execution_context" -> 'storageManifest' -> 'storages'
        ELSE '[]'::jsonb
      END
    ) AS storage(value)
    INNER JOIN "vm0_storage_archive_size_candidates" AS candidate
      ON candidate."storage_type" = 'volume'
      AND candidate."org_id" = run."org_id"
      AND candidate."storage_name" = storage.value ->> 'vasStorageName'
      AND NULLIF(storage.value ->> 'vasVersionId', '') IS NOT NULL
      AND left(
        candidate."id",
        length(storage.value ->> 'vasVersionId')
      ) = lower(storage.value ->> 'vasVersionId')
    WHERE queue."expires_at" > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found an active queue volume reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "runner_job_queue" AS queue
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          queue."execution_context" -> 'storageManifest' -> 'artifacts'
        ) = 'array'
          THEN queue."execution_context" -> 'storageManifest' -> 'artifacts'
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    INNER JOIN "vm0_storage_archive_size_candidates" AS candidate
      ON candidate."storage_type" = 'artifact'
      AND candidate."storage_id"::text = artifact.value ->> 'vasStorageId'
      AND NULLIF(artifact.value ->> 'vasVersionId', '') IS NOT NULL
      AND left(
        candidate."id",
        length(artifact.value ->> 'vasVersionId')
      ) = lower(artifact.value ->> 'vasVersionId')
    WHERE queue."expires_at" > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found an active queue artifact reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "storage_version_lineage" AS lineage
      ON lineage."storage_id" = candidate."storage_id"
      AND (
        lineage."version_id" = candidate."id"
        OR lineage."parent_version_id" = candidate."id"
      )
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a lineage reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "vm0_storage_archive_size_candidates" AS candidate
    INNER JOIN "system_storage_presigned_url_cache" AS cache
      ON cache."storage_version_id" = candidate."id"
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization found a presigned URL cache reference';
  END IF;
END
$$;
--> statement-breakpoint

UPDATE "storages" AS storage
SET
  "head_version_id" = NULL,
  "size" = 0,
  "file_count" = 0,
  "updated_at" = transaction_timestamp()
FROM "vm0_storage_archive_size_candidates" AS candidate
WHERE storage."id" = candidate."storage_id"
  AND storage."head_version_id" = candidate."id";
--> statement-breakpoint

DELETE FROM "storage_versions" AS version
USING "vm0_storage_archive_size_candidates" AS candidate
WHERE version."id" = candidate."id";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "storage_versions"
    WHERE "archive_size" IS NULL
  ) THEN
    RAISE EXCEPTION
      'storage archive-size finalization left null archive sizes';
  END IF;
END
$$;
--> statement-breakpoint

DROP INDEX "idx_storage_versions_archive_size_null";
--> statement-breakpoint
DROP TABLE "storage_archive_size_backfill_work";
--> statement-breakpoint
ALTER TABLE "storage_versions" ALTER COLUMN "archive_size" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "chk_storage_versions_archive_size_nonnegative" CHECK ("storage_versions"."archive_size" >= 0);
--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "chk_storage_versions_nonempty_archive_size_positive" CHECK ("storage_versions"."file_count" = 0 OR "storage_versions"."archive_size" > 0);
