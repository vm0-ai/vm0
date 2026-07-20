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
      storages.user_id,
      storages.name,
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
  candidate_volume_orgs AS MATERIALIZED (
    SELECT DISTINCT org_id
    FROM candidates
    WHERE type = 'volume'
  ),
  candidate_artifact_owners AS MATERIALIZED (
    SELECT DISTINCT org_id, user_id
    FROM candidates
    WHERE type = 'artifact'
  ),
  relevant_sessions AS MATERIALIZED (
    SELECT
      agent_sessions.org_id,
      agent_sessions.user_id,
      agent_sessions.artifacts
    FROM agent_sessions
    INNER JOIN candidate_artifact_owners
      ON candidate_artifact_owners.org_id = agent_sessions.org_id
      AND candidate_artifact_owners.user_id = agent_sessions.user_id
    WHERE jsonb_typeof(agent_sessions.artifacts) = 'array'
  ),
  session_artifact_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM relevant_sessions
    CROSS JOIN LATERAL jsonb_array_elements(
      relevant_sessions.artifacts
    ) AS artifact(value)
    INNER JOIN candidates
      ON candidates.type = 'artifact'
      AND candidates.org_id = relevant_sessions.org_id
      AND candidates.user_id = relevant_sessions.user_id
      AND candidates.name = artifact.value ->> 'name'
      AND left(
        candidates.id,
        length(artifact.value ->> 'version')
      ) = lower(artifact.value ->> 'version')
    WHERE NULLIF(artifact.value ->> 'version', '') IS NOT NULL
  ),
  relevant_runs AS MATERIALIZED (
    SELECT
      agent_runs.id,
      agent_runs.org_id,
      agent_runs.user_id,
      agent_runs.additional_volumes
    FROM agent_runs
    INNER JOIN candidate_artifact_owners
      ON candidate_artifact_owners.org_id = agent_runs.org_id
      AND candidate_artifact_owners.user_id = agent_runs.user_id

    UNION

    SELECT
      agent_runs.id,
      agent_runs.org_id,
      agent_runs.user_id,
      agent_runs.additional_volumes
    FROM agent_runs
    INNER JOIN candidate_volume_orgs
      ON candidate_volume_orgs.org_id = agent_runs.org_id
  ),
  relevant_checkpoints AS MATERIALIZED (
    SELECT
      relevant_runs.org_id,
      relevant_runs.user_id,
      checkpoints.artifact_snapshots,
      checkpoints.volume_versions_snapshot
    FROM checkpoints
    INNER JOIN relevant_runs
      ON relevant_runs.id = checkpoints.run_id
  ),
  checkpoint_artifact_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM relevant_checkpoints
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(relevant_checkpoints.artifact_snapshots) = 'array'
          THEN relevant_checkpoints.artifact_snapshots
        ELSE '[]'::jsonb
      END
    ) AS artifact(value)
    INNER JOIN candidates
      ON candidates.type = 'artifact'
      AND candidates.org_id = relevant_checkpoints.org_id
      AND candidates.user_id = relevant_checkpoints.user_id
      AND candidates.name = artifact.value ->> 'name'
      AND left(
        candidates.id,
        length(artifact.value ->> 'version')
      ) = lower(artifact.value ->> 'version')
    WHERE NULLIF(artifact.value ->> 'version', '') IS NOT NULL

    UNION

    SELECT DISTINCT candidates.id
    FROM relevant_checkpoints
    CROSS JOIN LATERAL jsonb_each_text(
      CASE
        WHEN jsonb_typeof(relevant_checkpoints.artifact_snapshots) = 'object'
          THEN relevant_checkpoints.artifact_snapshots
        ELSE '{}'::jsonb
      END
    ) AS artifact(key, value)
    INNER JOIN candidates
      ON candidates.type = 'artifact'
      AND candidates.org_id = relevant_checkpoints.org_id
      AND candidates.user_id = relevant_checkpoints.user_id
      AND candidates.name = artifact.key
      AND left(
        candidates.id,
        length(artifact.value)
      ) = lower(artifact.value)
    WHERE artifact.value <> ''
  ),
  checkpoint_volume_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM relevant_checkpoints
    CROSS JOIN LATERAL jsonb_each_text(
      CASE
        WHEN jsonb_typeof(
          relevant_checkpoints.volume_versions_snapshot -> 'versions'
        ) = 'object'
          THEN relevant_checkpoints.volume_versions_snapshot -> 'versions'
        ELSE '{}'::jsonb
      END
    ) AS version(key, value)
    INNER JOIN candidates
      ON candidates.type = 'volume'
      AND candidates.org_id = relevant_checkpoints.org_id
      AND candidates.name = version.key
      AND left(
        candidates.id,
        length(version.value)
      ) = lower(version.value)
    WHERE version.value <> ''

    UNION

    SELECT DISTINCT candidates.id
    FROM relevant_checkpoints
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          relevant_checkpoints.volume_versions_snapshot -> 'additionalVolumes'
        ) = 'array'
          THEN relevant_checkpoints.volume_versions_snapshot
            -> 'additionalVolumes'
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    INNER JOIN candidates
      ON candidates.type = 'volume'
      AND candidates.org_id = relevant_checkpoints.org_id
      AND candidates.name = volume.value ->> 'name'
      AND left(
        candidates.id,
        length(volume.value ->> 'versionId')
      ) = lower(volume.value ->> 'versionId')
    WHERE NULLIF(volume.value ->> 'versionId', '') IS NOT NULL
  ),
  run_additional_volume_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM relevant_runs
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(relevant_runs.additional_volumes) = 'array'
          THEN relevant_runs.additional_volumes
        ELSE '[]'::jsonb
      END
    ) AS volume(value)
    INNER JOIN candidates
      ON candidates.type = 'volume'
      AND candidates.org_id = relevant_runs.org_id
      AND candidates.name = volume.value ->> 'name'
      AND left(
        candidates.id,
        length(volume.value ->> 'version')
      ) = lower(volume.value ->> 'version')
    WHERE NULLIF(volume.value ->> 'version', '') IS NOT NULL
  ),
  active_queue_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM runner_job_queue
    INNER JOIN relevant_runs
      ON relevant_runs.id = runner_job_queue.run_id
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
    INNER JOIN candidates
      ON candidates.type = 'volume'
      AND candidates.org_id = relevant_runs.org_id
      AND candidates.name = storage.value ->> 'vasStorageName'
      AND left(
        candidates.id,
        length(storage.value ->> 'vasVersionId')
      ) = lower(storage.value ->> 'vasVersionId')
    WHERE runner_job_queue.expires_at > transaction_timestamp()
      AND NULLIF(storage.value ->> 'vasVersionId', '') IS NOT NULL

    UNION

    SELECT DISTINCT candidates.id
    FROM runner_job_queue
    INNER JOIN relevant_runs
      ON relevant_runs.id = runner_job_queue.run_id
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
    INNER JOIN candidates
      ON candidates.type = 'artifact'
      AND candidates.storage_id::text =
        artifact.value ->> 'vasStorageId'
      AND left(
        candidates.id,
        length(artifact.value ->> 'vasVersionId')
      ) = lower(artifact.value ->> 'vasVersionId')
    WHERE runner_job_queue.expires_at > transaction_timestamp()
      AND NULLIF(artifact.value ->> 'vasVersionId', '') IS NOT NULL
  ),
  lineage_version_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM candidates
    INNER JOIN storage_version_lineage
      ON storage_version_lineage.storage_id = candidates.storage_id
      AND storage_version_lineage.version_id = candidates.id
  ),
  lineage_parent_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM candidates
    INNER JOIN storage_version_lineage
      ON storage_version_lineage.storage_id = candidates.storage_id
      AND storage_version_lineage.parent_version_id = candidates.id
  ),
  system_url_cache_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM candidates
    INNER JOIN system_storage_presigned_url_cache
      ON system_storage_presigned_url_cache.storage_version_id =
        candidates.id
  ),
  shared_prefix_matches AS MATERIALIZED (
    SELECT DISTINCT candidates.id
    FROM candidates
    INNER JOIN storages AS other_storage
      ON other_storage.s3_prefix = candidates.s3_prefix
      AND other_storage.id <> candidates.storage_id
  ),
  reference_flags AS (
    SELECT
      candidates.*,
      candidates.head_version_id = candidates.id AS current_head,
      EXISTS (
        SELECT 1
        FROM session_artifact_matches
        WHERE session_artifact_matches.id = candidates.id
      ) AS session_artifact_ref,
      EXISTS (
        SELECT 1
        FROM checkpoint_artifact_matches
        WHERE checkpoint_artifact_matches.id = candidates.id
      ) AS checkpoint_artifact_ref,
      EXISTS (
        SELECT 1
        FROM checkpoint_volume_matches
        WHERE checkpoint_volume_matches.id = candidates.id
      ) AS checkpoint_volume_ref,
      EXISTS (
        SELECT 1
        FROM run_additional_volume_matches
        WHERE run_additional_volume_matches.id = candidates.id
      ) AS run_additional_volume_ref,
      EXISTS (
        SELECT 1
        FROM active_queue_matches
        WHERE active_queue_matches.id = candidates.id
      ) AS active_queue_ref,
      EXISTS (
        SELECT 1
        FROM lineage_version_matches
        WHERE lineage_version_matches.id = candidates.id
      ) AS lineage_version_ref,
      EXISTS (
        SELECT 1
        FROM lineage_parent_matches
        WHERE lineage_parent_matches.id = candidates.id
      ) AS lineage_parent_ref,
      EXISTS (
        SELECT 1
        FROM system_url_cache_matches
        WHERE system_url_cache_matches.id = candidates.id
      ) AS system_url_cache_ref,
      EXISTS (
        SELECT 1
        FROM shared_prefix_matches
        WHERE shared_prefix_matches.id = candidates.id
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
