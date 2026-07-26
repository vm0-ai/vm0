-- Phase 4A contracts only the state used by session continuation. Historical
-- run and checkpoint rows remain outside this migration because arbitrary
-- checkpoint resume is a separate legacy path. Keep artifact version
-- declarations unchanged: omitted and "latest" versions must continue to
-- resolve HEAD at run time instead of freezing the HEAD visible here.
-- Historical apiAutoMemory declarations may retain generatedBy provenance,
-- which is not part of mount behavior. Legacy continuation also initializes an
-- empty artifact Storage when a dynamic declaration has lost its Storage row;
-- materialize the same canonical identity before validating the backfill.
LOCK TABLE "agent_sessions" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "storages" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "storage_versions" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

CREATE TEMP TABLE vm0_session_missing_latest_storage_plan ON COMMIT DROP AS
WITH missing_storage_identities AS (
  SELECT DISTINCT
    session."org_id",
    session."user_id",
    artifact.value ->> 'name' AS name
  FROM "agent_sessions" AS session
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(session."artifacts") = 'array'
        THEN session."artifacts"
      ELSE '[]'::jsonb
    END
  ) AS artifact(value)
  LEFT JOIN "storages" AS storage
    ON storage."org_id" = session."org_id"
    AND storage."user_id" = session."user_id"
    AND storage."name" = artifact.value ->> 'name'
  WHERE session."storage_mounts" IS NULL
    AND jsonb_typeof(artifact.value) = 'object'
    AND jsonb_typeof(artifact.value -> 'name') = 'string'
    AND jsonb_typeof(artifact.value -> 'mountPath') = 'string'
    AND (
      NOT (artifact.value ? 'version')
      OR (
        jsonb_typeof(artifact.value -> 'version') = 'string'
        AND artifact.value ->> 'version' = 'latest'
      )
    )
    AND storage."id" IS NULL
),
new_storage_identities AS (
  SELECT
    gen_random_uuid() AS storage_id,
    missing."org_id",
    missing."user_id",
    missing.name
  FROM missing_storage_identities AS missing
)
SELECT
  identity.storage_id,
  identity."org_id",
  identity."user_id",
  identity.name,
  identity."org_id" || '/' || identity.storage_id::text AS s3_prefix,
  encode(
    digest(
      'storage:' || identity.storage_id::text || E'\n',
      'sha256'
    ),
    'hex'
  ) AS version_id
FROM new_storage_identities AS identity;
--> statement-breakpoint

INSERT INTO "storages" (
  "id",
  "user_id",
  "name",
  "type",
  "org_id",
  "s3_prefix"
)
SELECT
  plan.storage_id,
  plan."user_id",
  plan.name,
  'artifact',
  plan."org_id",
  plan.s3_prefix
FROM pg_temp.vm0_session_missing_latest_storage_plan AS plan;
--> statement-breakpoint

INSERT INTO "storage_versions" (
  "id",
  "storage_id",
  "s3_key",
  "size",
  "archive_size",
  "file_count",
  "message",
  "created_by"
)
SELECT
  plan.version_id,
  plan.storage_id,
  plan.s3_prefix || '/' || plan.version_id,
  0,
  0,
  0,
  'Initial empty artifact',
  plan."user_id"
FROM pg_temp.vm0_session_missing_latest_storage_plan AS plan;
--> statement-breakpoint

UPDATE "storages" AS storage
SET
  "head_version_id" = plan.version_id,
  "updated_at" = now()
FROM pg_temp.vm0_session_missing_latest_storage_plan AS plan
WHERE storage."id" = plan.storage_id;
--> statement-breakpoint

DO $$
DECLARE
  malformed_sessions bigint;
  duplicate_sessions bigint;
  missing_storage_sessions bigint;
  unresolved_version_sessions bigint;
  malformed_canonical_sessions bigint;
  duplicate_canonical_sessions bigint;
  stale_canonical_identity_sessions bigint;
  unresolved_canonical_version_sessions bigint;
  canonical_conflict_sessions bigint;
BEGIN
  SELECT count(*)
  INTO malformed_sessions
  FROM "agent_sessions" AS session
  WHERE jsonb_typeof(session."artifacts") IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(session."artifacts") = 'array'
            THEN session."artifacts"
          ELSE '[]'::jsonb
        END
      ) AS artifact(value)
      WHERE jsonb_typeof(artifact.value) IS DISTINCT FROM 'object'
        OR jsonb_typeof(artifact.value -> 'name') IS DISTINCT FROM 'string'
        OR jsonb_typeof(artifact.value -> 'mountPath') IS DISTINCT FROM 'string'
        OR (
          artifact.value ? 'version'
          AND jsonb_typeof(artifact.value -> 'version') IS DISTINCT FROM 'string'
        )
        OR (
          artifact.value ? 'missingRootPolicy'
          AND (
            jsonb_typeof(artifact.value -> 'missingRootPolicy') IS DISTINCT FROM 'string'
            OR artifact.value ->> 'missingRootPolicy'
              NOT IN ('fail', 'preserveParentVersion')
          )
        )
        OR (
          artifact.value ? 'generatedBy'
          AND (
            jsonb_typeof(artifact.value -> 'generatedBy') IS DISTINCT FROM 'string'
            OR artifact.value ->> 'generatedBy' <> 'apiAutoMemory'
          )
        )
        OR artifact.value
          - ARRAY[
            'name',
            'version',
            'mountPath',
            'missingRootPolicy',
            'generatedBy'
          ]::text[]
          <> '{}'::jsonb
    );

  WITH valid_artifacts AS (
    SELECT
      session."id" AS session_id,
      artifact.value
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."artifacts") = 'array'
          THEN session."artifacts"
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE jsonb_typeof(artifact.value) = 'object'
      AND jsonb_typeof(artifact.value -> 'name') = 'string'
      AND jsonb_typeof(artifact.value -> 'mountPath') = 'string'
  ),
  duplicate_groups AS (
    SELECT artifact.session_id
    FROM valid_artifacts AS artifact
    GROUP BY artifact.session_id, artifact.value ->> 'name'
    HAVING count(*) > 1

    UNION

    SELECT artifact.session_id
    FROM valid_artifacts AS artifact
    GROUP BY artifact.session_id, artifact.value ->> 'mountPath'
    HAVING count(*) > 1
  )
  SELECT count(DISTINCT duplicate.session_id)
  INTO duplicate_sessions
  FROM duplicate_groups AS duplicate;

  WITH valid_artifacts AS (
    SELECT
      session."id" AS session_id,
      session."org_id",
      session."user_id",
      artifact.value
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."artifacts") = 'array'
          THEN session."artifacts"
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE jsonb_typeof(artifact.value) = 'object'
      AND jsonb_typeof(artifact.value -> 'name') = 'string'
      AND jsonb_typeof(artifact.value -> 'mountPath') = 'string'
  )
  SELECT count(DISTINCT artifact.session_id)
  INTO missing_storage_sessions
  FROM valid_artifacts AS artifact
  LEFT JOIN "storages" AS storage
    ON storage."org_id" = artifact."org_id"
    AND storage."user_id" = artifact."user_id"
    AND storage."name" = artifact.value ->> 'name'
  WHERE storage."id" IS NULL;

  WITH valid_artifacts AS (
    SELECT
      session."id" AS session_id,
      artifact.value,
      storage."id" AS storage_id,
      storage."head_version_id"
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."artifacts") = 'array'
          THEN session."artifacts"
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    INNER JOIN "storages" AS storage
      ON storage."org_id" = session."org_id"
      AND storage."user_id" = session."user_id"
      AND storage."name" = artifact.value ->> 'name'
    WHERE jsonb_typeof(artifact.value) = 'object'
      AND jsonb_typeof(artifact.value -> 'name') = 'string'
      AND jsonb_typeof(artifact.value -> 'mountPath') = 'string'
  )
  SELECT count(DISTINCT artifact.session_id)
  INTO unresolved_version_sessions
  FROM valid_artifacts AS artifact
  WHERE (
      (
        NOT (artifact.value ? 'version')
        OR artifact.value ->> 'version' = 'latest'
      )
      AND (
        artifact.head_version_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "storage_versions" AS version
          WHERE version."id" = artifact.head_version_id
        )
      )
    )
    OR (
      artifact.value ? 'version'
      AND artifact.value ->> 'version' <> 'latest'
      AND NOT EXISTS (
        SELECT 1
        FROM "storage_versions" AS exact_version
        WHERE exact_version."storage_id" = artifact.storage_id
          AND exact_version."id" = artifact.value ->> 'version'
      )
      AND (
        length(artifact.value ->> 'version') < 8
        OR artifact.value ->> 'version' !~ '^[a-fA-F0-9]+$'
        OR (
          SELECT count(*)
          FROM (
            SELECT 1
            FROM "storage_versions" AS prefix_version
            WHERE prefix_version."storage_id" = artifact.storage_id
              AND prefix_version."id" LIKE (artifact.value ->> 'version') || '%'
            LIMIT 2
          ) AS prefix_matches
        ) <> 1
      )
    );

  SELECT count(*)
  INTO malformed_canonical_sessions
  FROM "agent_sessions" AS session
  WHERE session."storage_mounts" IS NOT NULL
    AND (
      jsonb_typeof(session."storage_mounts") IS DISTINCT FROM 'array'
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(session."storage_mounts") = 'array'
              THEN session."storage_mounts"
            ELSE '[]'::jsonb
          END
        ) AS mount(value)
        WHERE jsonb_typeof(mount.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(mount.value -> 'orgId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(mount.value -> 'userId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(mount.value -> 'name') IS DISTINCT FROM 'string'
          OR jsonb_typeof(mount.value -> 'storageId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(mount.value -> 'mountPath') IS DISTINCT FROM 'string'
          OR mount.value -> 'writeback' IS DISTINCT FROM 'true'::jsonb
          OR (
            mount.value ? 'version'
            AND jsonb_typeof(mount.value -> 'version') IS DISTINCT FROM 'string'
          )
          OR (
            mount.value ? 'optional'
            AND jsonb_typeof(mount.value -> 'optional') IS DISTINCT FROM 'boolean'
          )
          OR (
            mount.value ? 'instructionsTargetFilename'
            AND jsonb_typeof(mount.value -> 'instructionsTargetFilename')
              IS DISTINCT FROM 'string'
          )
          OR (
            mount.value ? 'missingRootPolicy'
            AND (
              jsonb_typeof(mount.value -> 'missingRootPolicy') IS DISTINCT FROM 'string'
              OR mount.value ->> 'missingRootPolicy'
                NOT IN ('fail', 'preserveParentVersion')
            )
          )
          OR mount.value
            - ARRAY[
              'orgId',
              'userId',
              'name',
              'storageId',
              'version',
              'mountPath',
              'optional',
              'writeback',
              'instructionsTargetFilename',
              'missingRootPolicy'
            ]::text[]
            <> '{}'::jsonb
      )
    );

  WITH valid_mounts AS (
    SELECT
      session."id" AS session_id,
      mount.value
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."storage_mounts") = 'array'
          THEN session."storage_mounts"
        ELSE '[]'::jsonb
      END
    ) AS mount(value)
    WHERE session."storage_mounts" IS NOT NULL
      AND jsonb_typeof(mount.value) = 'object'
      AND jsonb_typeof(mount.value -> 'name') = 'string'
      AND jsonb_typeof(mount.value -> 'mountPath') = 'string'
  ),
  duplicate_groups AS (
    SELECT mount.session_id
    FROM valid_mounts AS mount
    GROUP BY mount.session_id, mount.value ->> 'name'
    HAVING count(*) > 1

    UNION

    SELECT mount.session_id
    FROM valid_mounts AS mount
    GROUP BY mount.session_id, mount.value ->> 'mountPath'
    HAVING count(*) > 1
  )
  SELECT count(DISTINCT duplicate.session_id)
  INTO duplicate_canonical_sessions
  FROM duplicate_groups AS duplicate;

  WITH valid_mounts AS (
    SELECT
      session."id" AS session_id,
      session."org_id",
      session."user_id",
      mount.value
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."storage_mounts") = 'array'
          THEN session."storage_mounts"
        ELSE '[]'::jsonb
      END
    ) AS mount(value)
    WHERE session."storage_mounts" IS NOT NULL
      AND jsonb_typeof(mount.value) = 'object'
      AND jsonb_typeof(mount.value -> 'orgId') = 'string'
      AND jsonb_typeof(mount.value -> 'userId') = 'string'
      AND jsonb_typeof(mount.value -> 'name') = 'string'
      AND jsonb_typeof(mount.value -> 'storageId') = 'string'
      AND jsonb_typeof(mount.value -> 'mountPath') = 'string'
  )
  SELECT count(DISTINCT mount.session_id)
  INTO stale_canonical_identity_sessions
  FROM valid_mounts AS mount
  LEFT JOIN "storages" AS storage
    ON storage."org_id" = mount.value ->> 'orgId'
    AND storage."user_id" = mount.value ->> 'userId'
    AND storage."name" = mount.value ->> 'name'
  WHERE mount.value ->> 'orgId' <> mount."org_id"
    OR mount.value ->> 'userId' <> mount."user_id"
    OR storage."id" IS NULL
    OR storage."id"::text <> mount.value ->> 'storageId';

  WITH valid_mounts AS (
    SELECT
      session."id" AS session_id,
      mount.value,
      storage."id" AS storage_id,
      storage."head_version_id"
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session."storage_mounts") = 'array'
          THEN session."storage_mounts"
        ELSE '[]'::jsonb
      END
    ) AS mount(value)
    INNER JOIN "storages" AS storage
      ON storage."org_id" = mount.value ->> 'orgId'
      AND storage."user_id" = mount.value ->> 'userId'
      AND storage."name" = mount.value ->> 'name'
      AND storage."id"::text = mount.value ->> 'storageId'
    WHERE session."storage_mounts" IS NOT NULL
      AND jsonb_typeof(mount.value) = 'object'
      AND jsonb_typeof(mount.value -> 'orgId') = 'string'
      AND jsonb_typeof(mount.value -> 'userId') = 'string'
      AND jsonb_typeof(mount.value -> 'name') = 'string'
      AND jsonb_typeof(mount.value -> 'storageId') = 'string'
      AND jsonb_typeof(mount.value -> 'mountPath') = 'string'
  )
  SELECT count(DISTINCT mount.session_id)
  INTO unresolved_canonical_version_sessions
  FROM valid_mounts AS mount
  WHERE (
      (
        NOT (mount.value ? 'version')
        OR mount.value ->> 'version' = 'latest'
      )
      AND (
        mount.head_version_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "storage_versions" AS version
          WHERE version."id" = mount.head_version_id
        )
      )
    )
    OR (
      mount.value ? 'version'
      AND mount.value ->> 'version' <> 'latest'
      AND NOT EXISTS (
        SELECT 1
        FROM "storage_versions" AS exact_version
        WHERE exact_version."storage_id" = mount.storage_id
          AND exact_version."id" = mount.value ->> 'version'
      )
      AND (
        length(mount.value ->> 'version') < 8
        OR mount.value ->> 'version' !~ '^[a-fA-F0-9]+$'
        OR (
          SELECT count(*)
          FROM (
            SELECT 1
            FROM "storage_versions" AS prefix_version
            WHERE prefix_version."storage_id" = mount.storage_id
              AND prefix_version."id" LIKE (mount.value ->> 'version') || '%'
            LIMIT 2
          ) AS prefix_matches
        ) <> 1
      )
    );

  SELECT count(*)
  INTO canonical_conflict_sessions
  FROM "agent_sessions" AS session
  WHERE session."storage_mounts" IS NOT NULL
    AND session."artifacts" <> '[]'::jsonb
    AND COALESCE(
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(artifact.value -> 'generatedBy') = 'string'
              AND artifact.value ->> 'generatedBy' = 'apiAutoMemory'
              THEN artifact.value - 'generatedBy'
            ELSE artifact.value
          END
          ORDER BY artifact.ordinality
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(session."artifacts") = 'array'
              THEN session."artifacts"
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS artifact(value, ordinality)
      ),
      '[]'::jsonb
    ) IS DISTINCT FROM COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'name', mount.value -> 'name',
              'version', mount.value -> 'version',
              'mountPath', mount.value -> 'mountPath',
              'missingRootPolicy', mount.value -> 'missingRootPolicy'
            )
          )
          ORDER BY mount.ordinality
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(session."storage_mounts") = 'array'
              THEN session."storage_mounts"
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS mount(value, ordinality)
        WHERE mount.value ->> 'writeback' = 'true'
      ),
      '[]'::jsonb
    );

  IF malformed_sessions > 0
    OR duplicate_sessions > 0
    OR missing_storage_sessions > 0
    OR unresolved_version_sessions > 0
    OR malformed_canonical_sessions > 0
    OR duplicate_canonical_sessions > 0
    OR stale_canonical_identity_sessions > 0
    OR unresolved_canonical_version_sessions > 0
    OR canonical_conflict_sessions > 0
  THEN
    RAISE EXCEPTION
      'session continuation Storage backfill blocked: malformed_sessions=%, duplicate_sessions=%, missing_storage_sessions=%, unresolved_version_sessions=%, malformed_canonical_sessions=%, duplicate_canonical_sessions=%, stale_canonical_identity_sessions=%, unresolved_canonical_version_sessions=%, canonical_conflict_sessions=%',
      malformed_sessions,
      duplicate_sessions,
      missing_storage_sessions,
      unresolved_version_sessions,
      malformed_canonical_sessions,
      duplicate_canonical_sessions,
      stale_canonical_identity_sessions,
      unresolved_canonical_version_sessions,
      canonical_conflict_sessions
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint

CREATE TEMP TABLE vm0_session_storage_mount_backfill_plan ON COMMIT DROP AS
SELECT
  session."id" AS session_id,
  COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'orgId', session."org_id",
          'userId', session."user_id",
          'name', artifact.value -> 'name',
          'storageId', storage."id",
          'version', artifact.value -> 'version',
          'mountPath', artifact.value -> 'mountPath',
          'writeback', true,
          'missingRootPolicy', artifact.value -> 'missingRootPolicy'
        )
      )
      ORDER BY artifact.ordinality
    ) FILTER (WHERE artifact.value IS NOT NULL),
    '[]'::jsonb
  ) AS storage_mounts
FROM "agent_sessions" AS session
LEFT JOIN LATERAL jsonb_array_elements(session."artifacts")
  WITH ORDINALITY AS artifact(value, ordinality)
  ON true
LEFT JOIN "storages" AS storage
  ON storage."org_id" = session."org_id"
  AND storage."user_id" = session."user_id"
  AND storage."name" = artifact.value ->> 'name'
WHERE session."storage_mounts" IS NULL
GROUP BY session."id";
--> statement-breakpoint

DO $$
DECLARE
  planned_sessions bigint;
  updated_sessions bigint;
BEGIN
  SELECT count(*)
  INTO planned_sessions
  FROM pg_temp.vm0_session_storage_mount_backfill_plan;

  UPDATE "agent_sessions" AS session
  SET "storage_mounts" = plan.storage_mounts
  FROM pg_temp.vm0_session_storage_mount_backfill_plan AS plan
  WHERE session."id" = plan.session_id
    AND session."storage_mounts" IS NULL;

  GET DIAGNOSTICS updated_sessions = ROW_COUNT;

  IF updated_sessions <> planned_sessions THEN
    RAISE EXCEPTION
      'session continuation Storage backfill planned % sessions but updated %',
      planned_sessions,
      updated_sessions
      USING ERRCODE = 'check_violation';
  END IF;

  RAISE NOTICE
    'session continuation Storage backfill canonicalized % latest session states',
    updated_sessions;
END
$$;
--> statement-breakpoint

DO $$
DECLARE
  unmigrated_sessions bigint;
  lossy_sessions bigint;
BEGIN
  SELECT count(*)
  INTO unmigrated_sessions
  FROM "agent_sessions"
  WHERE "storage_mounts" IS NULL;

  SELECT count(*)
  INTO lossy_sessions
  FROM "agent_sessions" AS session
  WHERE session."artifacts" <> '[]'::jsonb
    AND COALESCE(
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(artifact.value -> 'generatedBy') = 'string'
              AND artifact.value ->> 'generatedBy' = 'apiAutoMemory'
              THEN artifact.value - 'generatedBy'
            ELSE artifact.value
          END
          ORDER BY artifact.ordinality
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(session."artifacts") = 'array'
              THEN session."artifacts"
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS artifact(value, ordinality)
      ),
      '[]'::jsonb
    ) IS DISTINCT FROM COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'name', mount.value -> 'name',
              'version', mount.value -> 'version',
              'mountPath', mount.value -> 'mountPath',
              'missingRootPolicy', mount.value -> 'missingRootPolicy'
            )
          )
          ORDER BY mount.ordinality
        )
        FROM jsonb_array_elements(session."storage_mounts")
          WITH ORDINALITY AS mount(value, ordinality)
        WHERE mount.value ->> 'writeback' = 'true'
      ),
      '[]'::jsonb
    );

  IF unmigrated_sessions > 0 OR lossy_sessions > 0 THEN
    RAISE EXCEPTION
      'session continuation Storage readiness failed: unmigrated_sessions=%, lossy_sessions=%',
      unmigrated_sessions,
      lossy_sessions
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
