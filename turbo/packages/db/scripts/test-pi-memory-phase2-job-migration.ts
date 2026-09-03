import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1059_restore_pi_memory_selection_watermark";
const phase2JobMigration = "1060_steady_talisman";
const testDatabase = "migration_pi_memory_phase2_jobs";

interface CandidateSnapshot {
  readonly createdAt: Date;
  readonly eligibleAt: Date;
  readonly generatedAt: Date | null;
  readonly lastErrorClass: string | null;
  readonly lastSelectedSourceHistoryHash: string | null;
  readonly lastUsedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseToken: string | null;
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly piSessionId: string;
  readonly rawMemory: string | null;
  readonly retryAt: Date | null;
  readonly retryCount: number;
  readonly rolloutSlug: string | null;
  readonly rolloutSummary: string | null;
  readonly sourceCompletedAt: Date;
  readonly sourceHistoryHash: string;
  readonly sourceRunId: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly usageCount: number;
  readonly userId: string;
}

interface JobSnapshot {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly inputRevision: number;
  readonly completedRevision: number;
  readonly claimedRevision: number | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly retryCount: number;
  readonly retryAt: Date | null;
  readonly lastErrorClass: string | null;
  readonly lastSucceededAt: Date | null;
  readonly claimedSelectionDigest: string | null;
  readonly claimedSelectedCount: number | null;
  readonly claimedSelectedUtf8Bytes: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function readCandidates(client: Client): Promise<CandidateSnapshot[]> {
  const result = await client.query<CandidateSnapshot>(`
    SELECT
      "memory_storage_id" AS "memoryStorageId",
      "org_id" AS "orgId",
      "user_id" AS "userId",
      "pi_session_id" AS "piSessionId",
      "source_run_id" AS "sourceRunId",
      "source_history_hash" AS "sourceHistoryHash",
      "source_completed_at" AS "sourceCompletedAt",
      "eligible_at" AS "eligibleAt",
      "status",
      "lease_token" AS "leaseToken",
      "lease_expires_at" AS "leaseExpiresAt",
      "retry_at" AS "retryAt",
      "retry_count" AS "retryCount",
      "last_error_class" AS "lastErrorClass",
      "raw_memory" AS "rawMemory",
      "rollout_summary" AS "rolloutSummary",
      "rollout_slug" AS "rolloutSlug",
      "generated_at" AS "generatedAt",
      "last_selected_source_history_hash" AS "lastSelectedSourceHistoryHash",
      "usage_count" AS "usageCount",
      "last_used_at" AS "lastUsedAt",
      "created_at" AS "createdAt",
      "updated_at" AS "updatedAt"
    FROM "pi_memory_stage1_candidates"
    ORDER BY "memory_storage_id", "pi_session_id"
  `);
  return result.rows;
}

async function readJobs(client: Client): Promise<JobSnapshot[]> {
  const result = await client.query<JobSnapshot>(`
    SELECT
      "memory_storage_id" AS "memoryStorageId",
      "org_id" AS "orgId",
      "user_id" AS "userId",
      "status",
      "input_revision" AS "inputRevision",
      "completed_revision" AS "completedRevision",
      "claimed_revision" AS "claimedRevision",
      "lease_token" AS "leaseToken",
      "lease_expires_at" AS "leaseExpiresAt",
      "retry_count" AS "retryCount",
      "retry_at" AS "retryAt",
      "last_error_class" AS "lastErrorClass",
      "last_succeeded_at" AS "lastSucceededAt",
      "claimed_selection_digest" AS "claimedSelectionDigest",
      "claimed_selected_count" AS "claimedSelectedCount",
      "claimed_selected_utf8_bytes" AS "claimedSelectedUtf8Bytes",
      "created_at" AS "createdAt",
      "updated_at" AS "updatedAt"
    FROM "pi_memory_phase2_jobs"
    ORDER BY "memory_storage_id"
  `);
  return result.rows;
}

export async function validatePiMemoryPhase2JobMigration(): Promise<void> {
  console.log("=== Validate Pi memory Phase 2 job migration ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const admin = new Client({
    connectionString: databaseUrlFor(databaseUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({
    connectionString: databaseUrlFor(databaseUrl, testDatabase),
  });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    const fixture = {
      successfulStorageId: "00000000-0000-4000-8000-000000312371",
      unsuccessfulStorageId: "00000000-0000-4000-8000-000000312372",
      noOutputStorageId: "00000000-0000-4000-8000-000000312373",
      successfulOrgId: "pi-memory-phase2-success-org",
      successfulUserId: "pi-memory-phase2-success-user",
      unsuccessfulOrgId: "pi-memory-phase2-unsuccessful-org",
      unsuccessfulUserId: "pi-memory-phase2-unsuccessful-user",
      noOutputOrgId: "pi-memory-phase2-no-output-org",
      noOutputUserId: "pi-memory-phase2-no-output-user",
      hashes: ["a", "b", "c", "d", "e"].map((value) => {
        return value.repeat(64);
      }),
    } as const;
    await client.query(
      `
        INSERT INTO "blobs" (
          "hash", "raw_size", "ref_count", "encoding", "encoded_size"
        )
        SELECT hash, 1, 1, 'identity', 1
        FROM unnest($1::varchar[]) AS hash
      `,
      [fixture.hashes],
    );
    await client.query(
      `
        INSERT INTO "storages" (
          "id", "org_id", "user_id", "name", "s3_prefix"
        ) VALUES
          ($1::uuid, $2, $3, 'memory', $2 || '/' || ($1::uuid)::text),
          ($4::uuid, $5, $6, 'memory', $5 || '/' || ($4::uuid)::text),
          ($7::uuid, $8, $9, 'memory', $8 || '/' || ($7::uuid)::text)
      `,
      [
        fixture.successfulStorageId,
        fixture.successfulOrgId,
        fixture.successfulUserId,
        fixture.unsuccessfulStorageId,
        fixture.unsuccessfulOrgId,
        fixture.unsuccessfulUserId,
        fixture.noOutputStorageId,
        fixture.noOutputOrgId,
        fixture.noOutputUserId,
      ],
    );
    await client.query(
      `
        INSERT INTO "pi_memory_stage1_candidates" (
          "memory_storage_id", "org_id", "user_id", "pi_session_id",
          "source_run_id", "source_history_hash", "source_completed_at",
          "eligible_at", "status", "retry_count", "last_error_class",
          "raw_memory", "rollout_summary", "rollout_slug", "generated_at",
          "usage_count", "last_used_at", "created_at", "updated_at"
        ) VALUES
          (
            $1, $2, $3, 'success-a',
            '00000000-0000-4000-8000-000000312381', $10,
            '2026-09-02 01:02:03', '2026-09-02 01:32:03', 'succeeded', 2,
            NULL, 'preserved raw memory', 'preserved rollout summary',
            'preserved-slug', '2026-09-02 02:03:04', 7,
            '2026-09-02 03:04:05', '2026-09-02 00:01:02',
            '2026-09-02 04:05:06'
          ),
          (
            $1, $2, $3, 'success-b',
            '00000000-0000-4000-8000-000000312382', $11,
            '2026-09-02 05:06:07', '2026-09-02 05:36:07', 'succeeded', 0,
            NULL, 'second raw memory', 'second rollout summary', NULL,
            '2026-09-02 06:07:08', 3, NULL,
            '2026-09-02 00:02:03', '2026-09-02 08:09:10'
          ),
          (
            $4, $5, $6, 'pending-only',
            '00000000-0000-4000-8000-000000312383', $12,
            '2026-09-02 09:10:11', '2026-09-02 09:40:11', 'pending', 0,
            NULL, NULL, NULL, NULL, NULL, 0, NULL,
            '2026-09-02 00:03:04', '2026-09-02 10:11:12'
          ),
          (
            $4, $5, $6, 'terminal-only',
            '00000000-0000-4000-8000-000000312384', $13,
            '2026-09-02 11:12:13', '2026-09-02 11:42:13',
            'terminal_failure', 5, 'attempts_exhausted', NULL, NULL, NULL,
            NULL, 0, NULL, '2026-09-02 00:04:05',
            '2026-09-02 12:13:14'
          ),
          (
            $7, $8, $9, 'no-output',
            '00000000-0000-4000-8000-000000312385', $14,
            '2026-09-02 13:14:15', '2026-09-02 13:44:15',
            'succeeded_no_output', 1, NULL, NULL, NULL, NULL,
            '2026-09-02 14:15:16', 4, '2026-09-02 15:16:17',
            '2026-09-02 00:05:06', '2026-09-02 16:17:18'
          )
      `,
      [
        fixture.successfulStorageId,
        fixture.successfulOrgId,
        fixture.successfulUserId,
        fixture.unsuccessfulStorageId,
        fixture.unsuccessfulOrgId,
        fixture.unsuccessfulUserId,
        fixture.noOutputStorageId,
        fixture.noOutputOrgId,
        fixture.noOutputUserId,
        ...fixture.hashes,
      ],
    );
    const candidatesBefore = await readCandidates(client);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      phase2JobMigration,
    );
    assert.deepEqual(await readCandidates(client), candidatesBefore);

    const jobs = await readJobs(client);
    assert.deepEqual(
      jobs.map((job) => {
        const { createdAt, updatedAt, ...portable } = job;
        assert.ok(createdAt instanceof Date);
        assert.deepEqual(updatedAt, createdAt);
        return portable;
      }),
      [
        {
          memoryStorageId: fixture.successfulStorageId,
          orgId: fixture.successfulOrgId,
          userId: fixture.successfulUserId,
          status: "pending",
          inputRevision: 1,
          completedRevision: 0,
          claimedRevision: null,
          leaseToken: null,
          leaseExpiresAt: null,
          retryCount: 0,
          retryAt: null,
          lastErrorClass: null,
          lastSucceededAt: null,
          claimedSelectionDigest: null,
          claimedSelectedCount: null,
          claimedSelectedUtf8Bytes: null,
        },
        {
          memoryStorageId: fixture.noOutputStorageId,
          orgId: fixture.noOutputOrgId,
          userId: fixture.noOutputUserId,
          status: "pending",
          inputRevision: 1,
          completedRevision: 0,
          claimedRevision: null,
          leaseToken: null,
          leaseExpiresAt: null,
          retryCount: 0,
          retryAt: null,
          lastErrorClass: null,
          lastSucceededAt: null,
          claimedSelectionDigest: null,
          claimedSelectedCount: null,
          claimedSelectedUtf8Bytes: null,
        },
      ],
    );

    console.log("   ✅ successful stores backfill exactly one pending job");
    console.log("   ✅ unsuccessful-only stores remain job-free");
    console.log("   ✅ owner identity and all Stage 1 bytes remain exact\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}
