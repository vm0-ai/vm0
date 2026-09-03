import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1060_steady_talisman";
const publicationMigration = "1061_faithful_rafael_vega";
const upgradeDatabase = "migration_pi_memory_publication_upgrade";
const freshDatabase = "migration_pi_memory_publication_fresh";

const fixture = {
  storageId: "00000000-0000-4000-8000-000000031258",
  orgId: "pi-memory-publication-migration-org",
  userId: "pi-memory-publication-migration-user",
  baseVersionId: "a".repeat(64),
  preparedVersionId: "b".repeat(64),
  observedVersionId: "c".repeat(64),
  selectionDigest: "d".repeat(64),
} as const;

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreateDatabase(admin: Client, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
}

async function insertPreMigrationFixture(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "storages" (
        "id", "org_id", "user_id", "name", "s3_prefix"
      ) VALUES ($1::uuid, $2, $3, 'memory', $2 || '/' || $1)
    `,
    [fixture.storageId, fixture.orgId, fixture.userId],
  );
  await client.query(
    `
      INSERT INTO "storage_versions" (
        "id", "storage_id", "s3_key", "size", "archive_size",
        "file_count", "message", "created_by"
      ) VALUES ($1, $2::uuid, $3, 101, 67, 3, NULL, 'user')
    `,
    [
      fixture.baseVersionId,
      fixture.storageId,
      `${fixture.orgId}/${fixture.storageId}/${fixture.baseVersionId}`,
    ],
  );
  await client.query(
    `
      UPDATE "storages"
      SET "head_version_id" = $1, "size" = 101, "file_count" = 3
      WHERE "id" = $2::uuid
    `,
    [fixture.baseVersionId, fixture.storageId],
  );
  await client.query(
    `
      INSERT INTO "pi_memory_phase2_jobs" (
        "memory_storage_id", "org_id", "user_id", "status",
        "input_revision", "completed_revision", "retry_count",
        "created_at", "updated_at"
      ) VALUES (
        $1::uuid, $2, $3, 'pending', 3, 1, 0,
        '2026-09-03 01:02:03', '2026-09-03 04:05:06'
      )
    `,
    [fixture.storageId, fixture.orgId, fixture.userId],
  );
}

async function validateUpgradedState(client: Client): Promise<void> {
  const job = await client.query<{
    status: string;
    inputRevision: number;
    completedRevision: number;
    reconciliationRevision: number;
    claimedBaseVersionId: string | null;
    lastObservedHeadVersionId: string | null;
    conflictCount: number;
    lastConflictAt: Date | null;
    lastConflictingHeadVersionId: string | null;
    lastPublishedVersionId: string | null;
    lastPublishedAt: Date | null;
    createdAt: string;
    updatedAt: string;
  }>(`
    SELECT
      "status",
      "input_revision" AS "inputRevision",
      "completed_revision" AS "completedRevision",
      "reconciliation_revision" AS "reconciliationRevision",
      "claimed_base_version_id" AS "claimedBaseVersionId",
      "last_observed_head_version_id" AS "lastObservedHeadVersionId",
      "conflict_count" AS "conflictCount",
      "last_conflict_at" AS "lastConflictAt",
      "last_conflicting_head_version_id" AS "lastConflictingHeadVersionId",
      "last_published_version_id" AS "lastPublishedVersionId",
      "last_published_at" AS "lastPublishedAt",
      "created_at"::text AS "createdAt",
      "updated_at"::text AS "updatedAt"
    FROM "pi_memory_phase2_jobs"
    WHERE "memory_storage_id" = '${fixture.storageId}'::uuid
  `);
  assert.deepEqual(job.rows, [
    {
      status: "pending",
      inputRevision: 3,
      completedRevision: 1,
      reconciliationRevision: 0,
      claimedBaseVersionId: null,
      lastObservedHeadVersionId: null,
      conflictCount: 0,
      lastConflictAt: null,
      lastConflictingHeadVersionId: null,
      lastPublishedVersionId: null,
      lastPublishedAt: null,
      createdAt: "2026-09-03 01:02:03",
      updatedAt: "2026-09-03 04:05:06",
    },
  ]);

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO "pi_memory_publication_provenance" (
        "id", "memory_storage_id", "org_id", "user_id",
        "claimed_revision", "input_revision", "reconciliation_revision",
        "selection_digest", "selected_count", "selected_utf8_bytes",
        "base_version_id", "prepared_version_id", "observed_head_version_id",
        "writer", "outcome", "size", "archive_size", "file_count",
        "created_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000031259'::uuid,
        $1::uuid, $2, $3, 2, 3, 3, $4, 1, 42, $5, $6, $7,
        'reconciler', 'conflicted', 201, 167, 4, '2026-09-03 05:06:07'
      )
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `,
    [
      fixture.storageId,
      fixture.orgId,
      fixture.userId,
      fixture.selectionDigest,
      fixture.baseVersionId,
      fixture.preparedVersionId,
      fixture.observedVersionId,
    ],
  );
  assert.equal(inserted.rowCount, 1);
  const replay = await client.query(
    `
      INSERT INTO "pi_memory_publication_provenance" (
        "memory_storage_id", "org_id", "user_id", "claimed_revision",
        "input_revision", "reconciliation_revision", "selection_digest",
        "selected_count", "selected_utf8_bytes", "base_version_id",
        "prepared_version_id", "observed_head_version_id", "writer",
        "outcome", "size", "archive_size", "file_count", "created_at"
      ) VALUES (
        $1::uuid, $2, $3, 2, 3, 3, $4, 1, 42, $5, $6, $7,
        'reconciler', 'conflicted', 201, 167, 4, '2026-09-03 05:06:08'
      )
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `,
    [
      fixture.storageId,
      fixture.orgId,
      fixture.userId,
      fixture.selectionDigest,
      fixture.baseVersionId,
      fixture.preparedVersionId,
      fixture.observedVersionId,
    ],
  );
  assert.equal(replay.rowCount, 0);

  const columns = await client.query<{ columnName: string }>(`
    SELECT "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'pi_memory_publication_provenance'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(
    columns.rows.map((row) => {
      return row.columnName;
    }),
    [
      "id",
      "memory_storage_id",
      "org_id",
      "user_id",
      "claimed_revision",
      "input_revision",
      "reconciliation_revision",
      "selection_digest",
      "selected_count",
      "selected_utf8_bytes",
      "base_version_id",
      "prepared_version_id",
      "observed_head_version_id",
      "writer",
      "outcome",
      "size",
      "archive_size",
      "file_count",
      "created_at",
    ],
  );

  await client.query(
    `UPDATE "storages" SET "head_version_id" = NULL WHERE "id" = $1::uuid`,
    [fixture.storageId],
  );
  await client.query(`DELETE FROM "storages" WHERE "id" = $1::uuid`, [
    fixture.storageId,
  ]);
  const provenanceAfterDelete = await client.query(
    `SELECT 1 FROM "pi_memory_publication_provenance"`,
  );
  assert.equal(provenanceAfterDelete.rowCount, 0);
}

async function validateFreshSchema(client: Client): Promise<void> {
  const tables = await client.query<{ tableName: string }>(`
    SELECT "table_name" AS "tableName"
    FROM "information_schema"."tables"
    WHERE "table_schema" = 'public'
      AND "table_name" IN (
        'pi_memory_phase2_jobs',
        'pi_memory_publication_provenance'
      )
    ORDER BY "table_name"
  `);
  assert.deepEqual(
    tables.rows.map((row) => {
      return row.tableName;
    }),
    ["pi_memory_phase2_jobs", "pi_memory_publication_provenance"],
  );
  const requiredColumns = await client.query<{ columnName: string }>(`
    SELECT "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'pi_memory_phase2_jobs'
      AND "column_name" IN (
        'reconciliation_revision',
        'claimed_base_version_id',
        'last_observed_head_version_id',
        'conflict_count',
        'last_conflict_at',
        'last_conflicting_head_version_id',
        'last_published_version_id',
        'last_published_at'
      )
  `);
  assert.equal(requiredColumns.rowCount, 8);
}

export async function validatePiMemoryPublicationMigration(): Promise<void> {
  console.log("=== Validate Pi memory publication migration ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const admin = new Client({
    connectionString: databaseUrlFor(databaseUrl, "postgres"),
  });
  await admin.connect();
  await recreateDatabase(admin, upgradeDatabase);
  await recreateDatabase(admin, freshDatabase);

  const upgrade = new Client({
    connectionString: databaseUrlFor(databaseUrl, upgradeDatabase),
  });
  const fresh = new Client({
    connectionString: databaseUrlFor(databaseUrl, freshDatabase),
  });
  await upgrade.connect();
  await fresh.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      upgrade,
      migrationsDirectory,
      previousMigration,
    );
    await insertPreMigrationFixture(upgrade);
    await applyMigrationsFromDirectoryUpToTag(
      upgrade,
      migrationsDirectory,
      publicationMigration,
    );
    await validateUpgradedState(upgrade);

    await applyMigrationsFromDirectoryUpToTag(
      fresh,
      migrationsDirectory,
      publicationMigration,
    );
    await validateFreshSchema(fresh);
    console.log("   ✅ preceding-main Phase 2 job state remains exact");
    console.log("   ✅ provenance is content-free, idempotent, and cascaded");
    console.log("   ✅ fresh schema contains the full publication contract\n");
  } finally {
    await upgrade.end();
    await fresh.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.query(
      `DROP DATABASE IF EXISTS "${freshDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
}
