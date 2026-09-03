import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1058_wide_tyger_tiger";
const selectionWatermarkMigration =
  "1059_restore_pi_memory_selection_watermark";
const testDatabase = "migration_pi_memory_stage1_selection_watermark";
const selectedHashConstraint =
  "pi_memory_stage1_candidates_selected_hash_check";
const stateConstraint = "pi_memory_stage1_candidates_state_check";

interface CandidateSnapshot {
  readonly createdAt: Date;
  readonly eligibleAt: Date;
  readonly generatedAt: Date;
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

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "23514" &&
    Reflect.get(error, "constraint") === constraint
  );
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
    ORDER BY "pi_session_id"
  `);
  return result.rows;
}

export async function validatePiMemoryStage1SelectionWatermarkMigration(): Promise<void> {
  console.log(
    "=== Validate Pi memory Stage 1 selection-watermark migration ===\n",
  );
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
      storageId: "00000000-0000-4000-8000-000000312291",
      orgId: "pi-memory-selection-watermark-org",
      userId: "pi-memory-selection-watermark-user",
      successSessionId: "pi-memory-selection-watermark-success",
      noOutputSessionId: "pi-memory-selection-watermark-no-output",
      successRunId: "00000000-0000-4000-8000-000000312292",
      noOutputRunId: "00000000-0000-4000-8000-000000312293",
      successHash: "a".repeat(64),
      noOutputHash: "b".repeat(64),
    } as const;
    await client.query(
      `
        INSERT INTO "blobs" (
          "hash", "raw_size", "ref_count", "encoding", "encoded_size"
        ) VALUES
          ($1, 101, 1, 'identity', 101),
          ($2, 202, 1, 'identity', 202)
      `,
      [fixture.successHash, fixture.noOutputHash],
    );
    await client.query(
      `
        INSERT INTO "storages" (
          "id", "org_id", "user_id", "name", "s3_prefix"
        ) VALUES ($1, $2, $3, 'memory', $4)
      `,
      [
        fixture.storageId,
        fixture.orgId,
        fixture.userId,
        `${fixture.orgId}/${fixture.storageId}`,
      ],
    );
    await client.query(
      `
        INSERT INTO "pi_memory_stage1_candidates" (
          "memory_storage_id",
          "org_id",
          "user_id",
          "pi_session_id",
          "source_run_id",
          "source_history_hash",
          "source_completed_at",
          "eligible_at",
          "status",
          "retry_count",
          "raw_memory",
          "rollout_summary",
          "rollout_slug",
          "generated_at",
          "last_selected_source_history_hash",
          "usage_count",
          "last_used_at",
          "created_at",
          "updated_at"
        ) VALUES
          (
            $1, $2, $3, $4, $5, $6,
            '2026-09-02 01:02:03', '2026-09-02 01:32:03', 'succeeded', 4,
            'preserved raw memory', 'preserved rollout summary',
            'preserved-rollout-slug', '2026-09-02 02:03:04', $6, 7,
            '2026-09-02 03:04:05', '2026-09-02 00:01:02',
            '2026-09-02 04:05:06'
          ),
          (
            $1, $2, $3, $7, $8, $9,
            '2026-09-02 05:06:07', '2026-09-02 05:36:07',
            'succeeded_no_output', 2, NULL, NULL, NULL,
            '2026-09-02 06:07:08', $9, 3, '2026-09-02 07:08:09',
            '2026-09-02 00:02:03', '2026-09-02 08:09:10'
          )
      `,
      [
        fixture.storageId,
        fixture.orgId,
        fixture.userId,
        fixture.successSessionId,
        fixture.successRunId,
        fixture.successHash,
        fixture.noOutputSessionId,
        fixture.noOutputRunId,
        fixture.noOutputHash,
      ],
    );
    const before = await readCandidates(client);
    assert.deepEqual(
      before.map((candidate) => {
        return candidate.lastSelectedSourceHistoryHash;
      }),
      [fixture.noOutputHash, fixture.successHash],
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      selectionWatermarkMigration,
    );
    assert.deepEqual(
      await readCandidates(client),
      before.map((candidate) => {
        return { ...candidate, lastSelectedSourceHistoryHash: null };
      }),
    );

    await client.query(
      `
        UPDATE "pi_memory_stage1_candidates"
        SET "last_selected_source_history_hash" = "source_history_hash"
        WHERE "pi_session_id" = $1
      `,
      [fixture.successSessionId],
    );
    await assert.rejects(
      client.query(
        `
          UPDATE "pi_memory_stage1_candidates"
          SET "last_selected_source_history_hash" = $1
          WHERE "pi_session_id" = $2
        `,
        [fixture.noOutputHash, fixture.successSessionId],
      ),
      (error: unknown) => {
        return isConstraintViolation(error, selectedHashConstraint);
      },
    );

    await client.query(
      `
        UPDATE "pi_memory_stage1_candidates"
        SET "last_selected_source_history_hash" = "source_history_hash"
        WHERE "pi_session_id" = $1
      `,
      [fixture.noOutputSessionId],
    );
    await assert.rejects(
      client.query(
        `
          UPDATE "pi_memory_stage1_candidates"
          SET
            "status" = 'pending',
            "generated_at" = NULL
          WHERE "pi_session_id" = $1
        `,
        [fixture.noOutputSessionId],
      ),
      (error: unknown) => {
        return isConstraintViolation(error, stateConstraint);
      },
    );

    console.log("   ✅ existing success markers are cleared");
    console.log(
      "   ✅ Stage 1 content, ownership, counters, and time stay exact",
    );
    console.log("   ✅ both success states accept a null selection watermark");
    console.log(
      "   ✅ selected hashes stay exact and non-success stays null\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}
