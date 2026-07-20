\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH
  unresolved AS (
    SELECT
      storage_versions.id,
      storage_versions.storage_id,
      storage_versions.created_at,
      storage_versions.file_count,
      storages.type,
      storages.org_id,
      storages.s3_prefix,
      storages.head_version_id,
      storage_archive_size_backfill_work.outcome,
      storage_archive_size_backfill_work.error_code
    FROM storage_versions
    INNER JOIN storages
      ON storages.id = storage_versions.storage_id
    LEFT JOIN storage_archive_size_backfill_work
      ON storage_archive_size_backfill_work.storage_version_id =
        storage_versions.id
    WHERE storage_versions.archive_size IS NULL
  ),
  candidates AS (
    SELECT *
    FROM unresolved
    WHERE file_count > 0
  ),
  session_artifact_refs AS (
    SELECT DISTINCT artifact.value ->> 'version' AS version_id
    FROM agent_sessions
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(agent_sessions.artifacts) = 'array'
          THEN agent_sessions.artifacts
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE NULLIF(artifact.value ->> 'version', '') IS NOT NULL
  ),
  checkpoint_artifact_refs AS (
    SELECT DISTINCT artifact.value ->> 'version' AS version_id
    FROM checkpoints
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(checkpoints.artifact_snapshots) = 'array'
          THEN checkpoints.artifact_snapshots
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE NULLIF(artifact.value ->> 'version', '') IS NOT NULL

    UNION

    SELECT DISTINCT artifact.value AS version_id
    FROM checkpoints
    CROSS JOIN LATERAL jsonb_each_text(
      CASE
        WHEN jsonb_typeof(checkpoints.artifact_snapshots) = 'object'
          THEN checkpoints.artifact_snapshots
        ELSE '{}'::jsonb
      END
    ) AS artifact(key, value)
    WHERE artifact.value <> ''
  ),
  checkpoint_volume_refs AS (
    SELECT DISTINCT version.value AS version_id
    FROM checkpoints
    CROSS JOIN LATERAL jsonb_each_text(
      CASE
        WHEN jsonb_typeof(
          checkpoints.volume_versions_snapshot -> 'versions'
        ) = 'object'
          THEN checkpoints.volume_versions_snapshot -> 'versions'
        ELSE '{}'::jsonb
      END
    ) AS version(key, value)
    WHERE version.value <> ''

    UNION

    SELECT DISTINCT volume.value ->> 'versionId' AS version_id
    FROM checkpoints
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          checkpoints.volume_versions_snapshot -> 'additionalVolumes'
        ) = 'array'
          THEN checkpoints.volume_versions_snapshot -> 'additionalVolumes'
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    WHERE NULLIF(volume.value ->> 'versionId', '') IS NOT NULL
  ),
  run_additional_volume_refs AS (
    SELECT DISTINCT volume.value ->> 'version' AS version_id
    FROM agent_runs
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(agent_runs.additional_volumes) = 'array'
          THEN agent_runs.additional_volumes
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    WHERE NULLIF(volume.value ->> 'version', '') IS NOT NULL
  ),
  active_queue_refs AS (
    SELECT DISTINCT storage.value ->> 'vasVersionId' AS version_id
    FROM runner_job_queue
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          runner_job_queue.execution_context
            -> 'storageManifest'
            -> 'storages'
        ) = 'array'
          THEN runner_job_queue.execution_context
            -> 'storageManifest'
            -> 'storages'
        ELSE '[]'::jsonb
      END
    ) AS storage(value)
    WHERE runner_job_queue.expires_at > transaction_timestamp()
      AND NULLIF(storage.value ->> 'vasVersionId', '') IS NOT NULL

    UNION

    SELECT DISTINCT artifact.value ->> 'vasVersionId' AS version_id
    FROM runner_job_queue
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          runner_job_queue.execution_context
            -> 'storageManifest'
            -> 'artifacts'
        ) = 'array'
          THEN runner_job_queue.execution_context
            -> 'storageManifest'
            -> 'artifacts'
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    WHERE runner_job_queue.expires_at > transaction_timestamp()
      AND NULLIF(artifact.value ->> 'vasVersionId', '') IS NOT NULL
  ),
  reference_flags AS (
    SELECT
      candidates.*,
      candidates.head_version_id = candidates.id AS current_head,
      EXISTS (
        SELECT 1
        FROM session_artifact_refs
        WHERE left(
          candidates.id,
          length(session_artifact_refs.version_id)
        ) = lower(session_artifact_refs.version_id)
      ) AS session_artifact_ref,
      EXISTS (
        SELECT 1
        FROM checkpoint_artifact_refs
        WHERE left(
          candidates.id,
          length(checkpoint_artifact_refs.version_id)
        ) = lower(checkpoint_artifact_refs.version_id)
      ) AS checkpoint_artifact_ref,
      EXISTS (
        SELECT 1
        FROM checkpoint_volume_refs
        WHERE left(
          candidates.id,
          length(checkpoint_volume_refs.version_id)
        ) = lower(checkpoint_volume_refs.version_id)
      ) AS checkpoint_volume_ref,
      EXISTS (
        SELECT 1
        FROM run_additional_volume_refs
        WHERE left(
          candidates.id,
          length(run_additional_volume_refs.version_id)
        ) = lower(run_additional_volume_refs.version_id)
      ) AS run_additional_volume_ref,
      EXISTS (
        SELECT 1
        FROM active_queue_refs
        WHERE left(
          candidates.id,
          length(active_queue_refs.version_id)
        ) = lower(active_queue_refs.version_id)
      ) AS active_queue_ref,
      EXISTS (
        SELECT 1
        FROM storage_version_lineage
        WHERE storage_version_lineage.storage_id = candidates.storage_id
          AND storage_version_lineage.version_id = candidates.id
      ) AS lineage_version_ref,
      EXISTS (
        SELECT 1
        FROM storage_version_lineage
        WHERE storage_version_lineage.storage_id = candidates.storage_id
          AND storage_version_lineage.parent_version_id = candidates.id
      ) AS lineage_parent_ref,
      EXISTS (
        SELECT 1
        FROM system_storage_presigned_url_cache
        WHERE system_storage_presigned_url_cache.storage_version_id =
          candidates.id
      ) AS system_url_cache_ref,
      EXISTS (
        SELECT 1
        FROM storages AS other_storage
        WHERE other_storage.s3_prefix = candidates.s3_prefix
          AND other_storage.id <> candidates.storage_id
      ) AS shared_prefix,
      candidates.s3_prefix =
        candidates.org_id || '/' || candidates.storage_id::text
        AS unique_id_prefix
    FROM candidates
  ),
  classified AS (
    SELECT
      reference_flags.*,
      CASE
        WHEN created_at < TIMESTAMP '2025-11-30 10:44:11'
          THEN 'beforeArchiveCutover'
        WHEN created_at < TIMESTAMP '2025-12-22 07:33:04'
          THEN 'archiveBeforeObjectVerification'
        ELSE 'afterObjectVerification'
      END AS era,
      (
        current_head
        OR session_artifact_ref
        OR checkpoint_artifact_ref
        OR checkpoint_volume_ref
        OR run_additional_volume_ref
        OR active_queue_ref
        OR lineage_version_ref
        OR lineage_parent_ref
        OR system_url_cache_ref
      ) AS any_known_reference
    FROM reference_flags
  ),
  type_counts AS (
    SELECT COALESCE(
      jsonb_object_agg(type, version_count),
      '{}'::jsonb
    ) AS value
    FROM (
      SELECT type, count(*) AS version_count
      FROM classified
      GROUP BY type
    ) AS grouped_types
  )
SELECT jsonb_build_object(
  'generatedAt',
  to_char(
    transaction_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'remainingNull',
  jsonb_build_object(
    'total', (SELECT count(*) FROM unresolved),
    'nonEmpty', (SELECT count(*) FROM candidates),
    'empty', (SELECT count(*) FROM unresolved WHERE file_count = 0)
  ),
  'candidates',
  jsonb_build_object(
    'total', count(*),
    'distinctStorages', count(DISTINCT storage_id),
    'currentHeads', count(*) FILTER (WHERE current_head),
    'nonHeads', count(*) FILTER (WHERE NOT current_head),
    'withKnownReferences', count(*) FILTER (WHERE any_known_reference),
    'withoutKnownReferences', count(*) FILTER (
      WHERE NOT any_known_reference
    ),
    'nonHeadWithoutKnownReferences', count(*) FILTER (
      WHERE NOT current_head AND NOT any_known_reference
    )
  ),
  'eras',
  jsonb_build_object(
    'beforeArchiveCutover',
    jsonb_build_object(
      'total', count(*) FILTER (WHERE era = 'beforeArchiveCutover'),
      'currentHeads', count(*) FILTER (
        WHERE era = 'beforeArchiveCutover' AND current_head
      ),
      'withKnownReferences', count(*) FILTER (
        WHERE era = 'beforeArchiveCutover' AND any_known_reference
      ),
      'nonHeadWithoutKnownReferences', count(*) FILTER (
        WHERE era = 'beforeArchiveCutover'
          AND NOT current_head
          AND NOT any_known_reference
      )
    ),
    'archiveBeforeObjectVerification',
    jsonb_build_object(
      'total', count(*) FILTER (
        WHERE era = 'archiveBeforeObjectVerification'
      ),
      'currentHeads', count(*) FILTER (
        WHERE era = 'archiveBeforeObjectVerification' AND current_head
      ),
      'withKnownReferences', count(*) FILTER (
        WHERE era = 'archiveBeforeObjectVerification'
          AND any_known_reference
      ),
      'nonHeadWithoutKnownReferences', count(*) FILTER (
        WHERE era = 'archiveBeforeObjectVerification'
          AND NOT current_head
          AND NOT any_known_reference
      )
    ),
    'afterObjectVerification',
    jsonb_build_object(
      'total', count(*) FILTER (WHERE era = 'afterObjectVerification'),
      'currentHeads', count(*) FILTER (
        WHERE era = 'afterObjectVerification' AND current_head
      ),
      'withKnownReferences', count(*) FILTER (
        WHERE era = 'afterObjectVerification' AND any_known_reference
      ),
      'nonHeadWithoutKnownReferences', count(*) FILTER (
        WHERE era = 'afterObjectVerification'
          AND NOT current_head
          AND NOT any_known_reference
      )
    )
  ),
  'references',
  jsonb_build_object(
    'currentHead', count(*) FILTER (WHERE current_head),
    'sessionArtifact', count(*) FILTER (WHERE session_artifact_ref),
    'checkpointArtifact', count(*) FILTER (WHERE checkpoint_artifact_ref),
    'checkpointVolume', count(*) FILTER (WHERE checkpoint_volume_ref),
    'runAdditionalVolume', count(*) FILTER (
      WHERE run_additional_volume_ref
    ),
    'activeQueue', count(*) FILTER (WHERE active_queue_ref),
    'lineageVersion', count(*) FILTER (WHERE lineage_version_ref),
    'lineageParent', count(*) FILTER (WHERE lineage_parent_ref),
    'systemUrlCache', count(*) FILTER (WHERE system_url_cache_ref)
  ),
  'backfill',
  jsonb_build_object(
    'missing', count(*) FILTER (
      WHERE outcome = 'missing' AND error_code = 'archive-not-found'
    ),
    'invalid', count(*) FILTER (WHERE outcome = 'invalid'),
    'failed', count(*) FILTER (WHERE outcome = 'failed'),
    'unattemptedOrInFlight', count(*) FILTER (WHERE outcome IS NULL)
  ),
  'prefixes',
  jsonb_build_object(
    'uniqueStorageId', count(*) FILTER (WHERE unique_id_prefix),
    'legacy', count(*) FILTER (WHERE NOT unique_id_prefix),
    'shared', count(*) FILTER (WHERE shared_prefix)
  ),
  'storageTypes',
  (SELECT value FROM type_counts)
)::text
FROM classified;

COMMIT;
