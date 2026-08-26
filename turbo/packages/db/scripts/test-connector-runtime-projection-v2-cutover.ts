import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0998_agent_drafts_physical_switch";
const cutoverMigration = "0999_cutover_connector_runtime_projections_v2";
const testDatabasePrefix = "migration_connector_projection_v2";

const catalogDigest = `sha256:${"a".repeat(64)}`;
const connectorPayload = Buffer.from('{"slug":"x"}', "utf8");
const connectorDigest = `sha256:${createHash("sha256")
  .update(connectorPayload)
  .digest("hex")}`;

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
  messageIncludes: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      databaseErrorCode(error) === code &&
      error instanceof Error &&
      error.message.includes(messageIncludes)
    );
  });
}

async function runMigration(
  client: Client,
  migrationSql: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(migrationSql);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createDatabase(admin: Client, database: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${database}"`);
}

async function seedSyncState(client: Client, sourceId: string): Promise<void> {
  await client.query(
    `
      INSERT INTO "connector_catalog_sync_state" ("source_id", "schema_version")
      VALUES ($1, 1)
    `,
    [sourceId],
  );
}

async function seedProjectionSet(
  client: Client,
  args: {
    readonly backendVersion: string | null;
    readonly id: string;
    readonly projectionVersion: number;
    readonly sourceId: string;
  },
): Promise<void> {
  await seedSyncState(client, args.sourceId);
  await client.query(
    `
      INSERT INTO "connector_catalog_runtime_projection_sets" (
        "id",
        "source_id",
        "schema_version",
        "catalog_version",
        "catalog_digest",
        "projection_version",
        "connector_count",
        "catalog_validation_backend_version",
        "catalog_validation_build_commit_sha"
      )
      VALUES ($1, $2, 1, 'v2-fixture', $3, $4, 1, $5, NULL)
    `,
    [
      args.id,
      args.sourceId,
      catalogDigest,
      args.projectionVersion,
      args.backendVersion,
    ],
  );
}

async function seedProjectionRow(
  client: Client,
  args: {
    readonly connectorJson: string;
    readonly payload: Buffer | null;
    readonly projectionSetId: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "connector_catalog_runtime_projections" (
        "projection_set_id",
        "connector_slug",
        "connector_digest",
        "connector",
        "connector_payload"
      )
      VALUES ($1, 'x', $2, $3::jsonb, $4)
    `,
    [args.projectionSetId, connectorDigest, args.connectorJson, args.payload],
  );
}

function validateMigrationShape(migrationSql: string): void {
  const lockOffset = migrationSql.indexOf("LOCK TABLE");
  const preflightOffset = migrationSql.indexOf("DO $$");
  const firstAlterOffset = migrationSql.indexOf("ALTER TABLE");
  assert.ok(lockOffset >= 0);
  assert.ok(lockOffset < preflightOffset);
  assert.ok(preflightOffset < firstAlterOffset);
  assert.match(
    migrationSql,
    /LOCK TABLE\s+"connector_catalog_runtime_projection_sets",\s+"connector_catalog_runtime_projections"\s+IN ACCESS EXCLUSIVE MODE;/u,
  );
  assert.equal(migrationSql.match(/\bLIMIT 1000\b/gu)?.length, 3);
  assert.doesNotMatch(migrationSql, /\b(?:DELETE|INSERT|UPDATE)\b/u);
}

async function validateBlockedPreflight(
  client: Client,
  migrationSql: string,
): Promise<void> {
  const projectionSetId = "00000000-0000-4000-8000-000000099801";
  await seedProjectionSet(client, {
    backendVersion: null,
    id: projectionSetId,
    projectionVersion: 1,
    sourceId: "migration-v2-blocked",
  });
  await seedProjectionRow(client, {
    connectorJson: '{"slug":"x","legacy":true}',
    payload: null,
    projectionSetId,
  });

  await assert.rejects(
    runMigration(client, migrationSql),
    /cutover blocked: unsupported_version=1, missing_backend_authority=1, missing_payload=1/u,
  );

  const state = await client.query<{
    backendVersion: string | null;
    connector: unknown;
    payload: Buffer | null;
    projectionVersion: number;
  }>(
    `
      SELECT
        "projection_version" AS "projectionVersion",
        "catalog_validation_backend_version" AS "backendVersion",
        "connector",
        "connector_payload" AS "payload"
      FROM "connector_catalog_runtime_projection_sets"
      INNER JOIN "connector_catalog_runtime_projections"
        ON "connector_catalog_runtime_projections"."projection_set_id" =
          "connector_catalog_runtime_projection_sets"."id"
      WHERE "connector_catalog_runtime_projection_sets"."id" = $1
    `,
    [projectionSetId],
  );
  assert.deepEqual(state.rows, [
    {
      backendVersion: null,
      connector: { legacy: true, slug: "x" },
      payload: null,
      projectionVersion: 1,
    },
  ]);

  const nullability = await client.query<{
    columnName: string;
    isNullable: string;
  }>(`
    SELECT "column_name" AS "columnName", "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND (
        ("table_name" = 'connector_catalog_runtime_projection_sets'
          AND "column_name" = 'catalog_validation_backend_version')
        OR
        ("table_name" = 'connector_catalog_runtime_projections'
          AND "column_name" IN ('connector', 'connector_payload'))
      )
    ORDER BY "column_name"
  `);
  assert.deepEqual(nullability.rows, [
    { columnName: "catalog_validation_backend_version", isNullable: "YES" },
    { columnName: "connector", isNullable: "NO" },
    { columnName: "connector_payload", isNullable: "YES" },
  ]);
}

async function insertCompatibleProjection(
  client: Client,
  args: {
    readonly includeJson: boolean;
    readonly projectionSetId: string;
    readonly sourceId: string;
  },
): Promise<void> {
  await seedProjectionSet(client, {
    backendVersion: "1.492.2",
    id: args.projectionSetId,
    projectionVersion: 2,
    sourceId: args.sourceId,
  });
  if (args.includeJson) {
    await seedProjectionRow(client, {
      connectorJson: connectorPayload.toString("utf8"),
      payload: connectorPayload,
      projectionSetId: args.projectionSetId,
    });
    return;
  }
  await client.query(
    `
      INSERT INTO "connector_catalog_runtime_projections" (
        "projection_set_id",
        "connector_slug",
        "connector_digest",
        "connector_payload"
      )
      VALUES ($1, 'x', $2, $3)
    `,
    [args.projectionSetId, connectorDigest, connectorPayload],
  );
}

async function validateTransitionalSchema(client: Client): Promise<void> {
  const nullability = await client.query<{
    columnName: string;
    isNullable: string;
  }>(`
    SELECT "column_name" AS "columnName", "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND (
        ("table_name" = 'connector_catalog_runtime_projection_sets'
          AND "column_name" IN (
            'catalog_validation_backend_version',
            'catalog_validation_build_commit_sha'
          ))
        OR
        ("table_name" = 'connector_catalog_runtime_projections'
          AND "column_name" IN ('connector', 'connector_payload'))
      )
    ORDER BY "column_name"
  `);
  assert.deepEqual(nullability.rows, [
    { columnName: "catalog_validation_backend_version", isNullable: "NO" },
    { columnName: "catalog_validation_build_commit_sha", isNullable: "YES" },
    { columnName: "connector", isNullable: "YES" },
    { columnName: "connector_payload", isNullable: "NO" },
  ]);

  const constraints = await client.query<{
    definition: string;
    name: string;
  }>(`
    SELECT
      "conname" AS "name",
      pg_get_constraintdef("oid", true) AS "definition"
    FROM "pg_constraint"
    WHERE "conrelid" =
      'public.connector_catalog_runtime_projection_sets'::regclass
      AND "conname" IN (
        'connector_catalog_projection_sets_version_supported',
        'connector_catalog_projection_sets_validator_complete'
      )
    ORDER BY "conname"
  `);
  assert.deepEqual(
    constraints.rows.map(({ name }) => {
      return name;
    }),
    [
      "connector_catalog_projection_sets_validator_complete",
      "connector_catalog_projection_sets_version_supported",
    ],
  );

  assert.match(
    constraints.rows[1]?.definition ?? "",
    /CHECK \(projection_version = 2\)/u,
  );
}

async function validateCompatibilityMatrix(client: Client): Promise<void> {
  const outgoingSetId = "00000000-0000-4000-8000-000000099802";
  const currentSetId = "00000000-0000-4000-8000-000000099803";
  await insertCompatibleProjection(client, {
    includeJson: true,
    projectionSetId: outgoingSetId,
    sourceId: "migration-v2-outgoing-writer",
  });
  await insertCompatibleProjection(client, {
    includeJson: false,
    projectionSetId: currentSetId,
    sourceId: "migration-v2-current-writer",
  });

  const writtenRows = await client.query<{
    connectorIsNull: boolean;
    payload: Buffer;
    sourceId: string;
  }>(
    `
      SELECT
        "projection_set"."source_id" AS "sourceId",
        "projection_row"."connector" IS NULL AS "connectorIsNull",
        "projection_row"."connector_payload" AS "payload"
      FROM "connector_catalog_runtime_projection_sets" AS "projection_set"
      INNER JOIN "connector_catalog_runtime_projections" AS "projection_row"
        ON "projection_row"."projection_set_id" = "projection_set"."id"
      WHERE "projection_set"."id" = ANY($1::uuid[])
        AND "projection_set"."projection_version" = 2
      ORDER BY "projection_set"."source_id"
    `,
    [[currentSetId, outgoingSetId]],
  );
  assert.deepEqual(
    writtenRows.rows.map(({ connectorIsNull, payload, sourceId }) => {
      return {
        connectorIsNull,
        payload: payload.toString("utf8"),
        sourceId,
      };
    }),
    [
      {
        connectorIsNull: true,
        payload: connectorPayload.toString("utf8"),
        sourceId: "migration-v2-current-writer",
      },
      {
        connectorIsNull: false,
        payload: connectorPayload.toString("utf8"),
        sourceId: "migration-v2-outgoing-writer",
      },
    ],
  );

  const rollbackReaderRows = await client.query<{
    connectorDigest: string;
    connectorPayload: Buffer;
    connectorSlug: string;
  }>(
    `
      SELECT
        "connector_slug" AS "connectorSlug",
        "connector_digest" AS "connectorDigest",
        "connector_payload" AS "connectorPayload"
      FROM "connector_catalog_runtime_projections"
      WHERE "projection_set_id" = $1
    `,
    [currentSetId],
  );
  assert.deepEqual(rollbackReaderRows.rows, [
    {
      connectorDigest,
      connectorPayload,
      connectorSlug: "x",
    },
  ]);
}

async function validateContractRejections(client: Client): Promise<void> {
  await seedSyncState(client, "migration-v2-invalid-version");
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "connector_catalog_runtime_projection_sets" (
          "source_id", "schema_version", "catalog_version", "catalog_digest",
          "projection_version", "connector_count",
          "catalog_validation_backend_version"
        )
        VALUES ($1, 1, 'invalid-version', $2, 1, 1, '1.492.2')
      `,
      ["migration-v2-invalid-version", catalogDigest],
    ),
    "23514",
    "connector_catalog_projection_sets_version_supported",
  );

  await seedSyncState(client, "migration-v2-null-backend");
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "connector_catalog_runtime_projection_sets" (
          "source_id", "schema_version", "catalog_version", "catalog_digest",
          "projection_version", "connector_count",
          "catalog_validation_backend_version"
        )
        VALUES ($1, 1, 'null-backend', $2, 2, 1, NULL)
      `,
      ["migration-v2-null-backend", catalogDigest],
    ),
    "23502",
    "catalog_validation_backend_version",
  );

  await seedSyncState(client, "migration-v2-invalid-build");
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "connector_catalog_runtime_projection_sets" (
          "source_id", "schema_version", "catalog_version", "catalog_digest",
          "projection_version", "connector_count",
          "catalog_validation_backend_version",
          "catalog_validation_build_commit_sha"
        )
        VALUES ($1, 1, 'invalid-build', $2, 2, 1, '1.492.2', 'invalid')
      `,
      ["migration-v2-invalid-build", catalogDigest],
    ),
    "23514",
    "connector_catalog_projection_sets_validator_complete",
  );

  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "connector_catalog_runtime_projections" (
          "projection_set_id", "connector_slug", "connector_digest",
          "connector_payload"
        )
        VALUES ($1, 'missing', $2, NULL)
      `,
      ["00000000-0000-4000-8000-000000099803", connectorDigest],
    ),
    "23502",
    "connector_payload",
  );
}

async function validateSuccessfulCutover(
  client: Client,
  migrationSql: string,
): Promise<void> {
  const historicalSetId = "00000000-0000-4000-8000-000000099804";
  await insertCompatibleProjection(client, {
    includeJson: true,
    projectionSetId: historicalSetId,
    sourceId: "migration-v2-historical",
  });
  await runMigration(client, migrationSql);
  await validateTransitionalSchema(client);
  await validateCompatibilityMatrix(client);
  await validateContractRejections(client);
}

export async function validateConnectorRuntimeProjectionV2Cutover(): Promise<void> {
  console.log("=== Validate connector runtime projection v2 cutover ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${cutoverMigration}.sql`),
    "utf8",
  );
  validateMigrationShape(migrationSql);

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const databases = [
    `${testDatabasePrefix}_blocked`,
    `${testDatabasePrefix}_valid`,
  ] as const;
  try {
    for (const database of databases) {
      await createDatabase(admin, database);
      const targetUrl = new URL(databaseUrl);
      targetUrl.pathname = `/${database}`;
      const client = new Client({ connectionString: targetUrl.toString() });
      await client.connect();
      try {
        await applyMigrationsFromDirectoryUpToTag(
          client,
          migrationsDirectory,
          previousMigration,
        );
        if (database.endsWith("_blocked")) {
          await validateBlockedPreflight(client, migrationSql);
        } else {
          await validateSuccessfulCutover(client, migrationSql);
        }
      } finally {
        await client.end();
      }
    }

    console.log("   ✅ blocker state aborts without schema or data mutation");
    console.log("   ✅ v2 payload and authority invariants are enforced");
    console.log(
      "   ✅ outgoing, current, and rollback v2 statement shapes remain compatible\n",
    );
  } finally {
    for (const database of databases) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateConnectorRuntimeProjectionV2Cutover().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
