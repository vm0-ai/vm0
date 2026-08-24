import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import {
  deleteClerkAgentLifecycleData,
  deleteLegacyAgentIdentitiesInTransaction,
  scrubLegacyAgentComposeVersionCreatorInTransaction,
} from "../../../apps/api/src/signals/services/agent-compose-provenance-lifecycle.service";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const migration = "0974_canonical_agent_writes";
const testDatabase = "migration_agent_schema_absence_runtime_seal";

const fixture = {
  presentTargetAgentId: "00000000-0000-4000-8000-000000097801",
  presentPeerAgentId: "00000000-0000-4000-8000-000000097802",
  presentForeignAgentId: "00000000-0000-4000-8000-000000097803",
  raceAgentId: "00000000-0000-4000-8000-000000097804",
  userAgentId: "00000000-0000-4000-8000-000000097805",
  orgAgentId: "00000000-0000-4000-8000-000000097806",
  privacyMarkerAgentId: "00000000-0000-4000-8000-000000097807",
  userSessionId: "00000000-0000-4000-8000-000000097815",
  orgSessionId: "00000000-0000-4000-8000-000000097816",
  userRunId: "00000000-0000-4000-8000-000000097825",
  orgRunId: "00000000-0000-4000-8000-000000097826",
  userStorageId: "00000000-0000-4000-8000-000000097835",
  presentOrgId: "runtime-seal-present-org",
  foreignOrgId: "runtime-seal-foreign-org",
  userOrgId: "runtime-seal-user-org",
  clerkOrgId: "runtime-seal-clerk-org",
  privacyUserId: "runtime-seal-privacy-user",
  peerUserId: "runtime-seal-peer-user",
  clerkUserId: "runtime-seal-clerk-user",
  targetVersionId: "a".repeat(64),
  peerVersionId: "b".repeat(64),
  foreignVersionId: "c".repeat(64),
} as const;

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function resetDatabase(
  adminUrl: string,
  database: string,
): Promise<void> {
  const admin = await connect(adminUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
}

async function seedSchemaPresentState(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
      VALUES
        ($1, $4, $6, 'runtime-seal-present-target'),
        ($2, $5, $6, 'runtime-seal-present-peer'),
        ($3, $4, $7, 'runtime-seal-present-foreign')
    `,
    [
      fixture.presentTargetAgentId,
      fixture.presentPeerAgentId,
      fixture.presentForeignAgentId,
      fixture.privacyUserId,
      fixture.peerUserId,
      fixture.presentOrgId,
      fixture.foreignOrgId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_compose_versions" (
        "id", "compose_id", "content", "created_by"
      ) VALUES
        ($1, $4, '{"fixture":"target"}'::jsonb, $7),
        ($2, $5, '{"fixture":"peer"}'::jsonb, $8),
        ($3, $6, '{"fixture":"foreign"}'::jsonb, $7)
    `,
    [
      fixture.targetVersionId,
      fixture.peerVersionId,
      fixture.foreignVersionId,
      fixture.presentTargetAgentId,
      fixture.presentPeerAgentId,
      fixture.presentForeignAgentId,
      fixture.privacyUserId,
      fixture.peerUserId,
    ],
  );
}

async function assertSchemaPresentBoundary(client: Client): Promise<void> {
  const db = drizzle(client);
  await seedSchemaPresentState(client);

  await db.transaction(async (tx) => {
    await deleteLegacyAgentIdentitiesInTransaction(tx, {
      kind: "organization",
      orgId: fixture.presentOrgId,
      agentIds: [fixture.presentTargetAgentId, fixture.presentForeignAgentId],
    });
    await scrubLegacyAgentComposeVersionCreatorInTransaction(
      tx,
      fixture.privacyUserId,
    );
  });

  const afterOrganizationCleanup = await client.query<{
    id: string;
  }>(`SELECT "id"::text FROM "agent_composes" ORDER BY "id"`);
  assert.deepEqual(
    afterOrganizationCleanup.rows.map((row) => {
      return row.id;
    }),
    [fixture.presentPeerAgentId, fixture.presentForeignAgentId],
    "organization teardown must delete only exact IDs in the exact scope",
  );

  const retainedVersions = await client.query<{
    id: string;
    composeId: string | null;
    createdBy: string | null;
    content: { fixture: string };
  }>(`
    SELECT "id", "compose_id"::text AS "composeId",
      "created_by" AS "createdBy", "content"
    FROM "agent_compose_versions"
    ORDER BY "id"
  `);
  assert.deepEqual(retainedVersions.rows, [
    {
      id: fixture.targetVersionId,
      composeId: null,
      createdBy: null,
      content: { fixture: "target" },
    },
    {
      id: fixture.peerVersionId,
      composeId: fixture.presentPeerAgentId,
      createdBy: fixture.peerUserId,
      content: { fixture: "peer" },
    },
    {
      id: fixture.foreignVersionId,
      composeId: fixture.presentForeignAgentId,
      createdBy: null,
      content: { fixture: "foreign" },
    },
  ]);

  await db.transaction(async (tx) => {
    await deleteLegacyAgentIdentitiesInTransaction(tx, {
      kind: "user",
      userId: fixture.privacyUserId,
      agentIds: [fixture.presentForeignAgentId],
    });
  });
  await db.transaction(async (tx) => {
    await deleteLegacyAgentIdentitiesInTransaction(tx, {
      kind: "user",
      userId: fixture.privacyUserId,
      agentIds: [fixture.presentForeignAgentId],
    });
    await scrubLegacyAgentComposeVersionCreatorInTransaction(
      tx,
      fixture.privacyUserId,
    );
  });

  const afterDuplicateCleanup = await client.query<{ id: string }>(
    `SELECT "id"::text FROM "agent_composes" ORDER BY "id"`,
  );
  assert.deepEqual(afterDuplicateCleanup.rows, [
    { id: fixture.presentPeerAgentId },
  ]);
  const foreignVersion = await client.query<{
    composeId: string | null;
    createdBy: string | null;
  }>(
    `
      SELECT "compose_id"::text AS "composeId", "created_by" AS "createdBy"
      FROM "agent_compose_versions"
      WHERE "id" = $1
    `,
    [fixture.foreignVersionId],
  );
  assert.deepEqual(foreignVersion.rows, [{ composeId: null, createdBy: null }]);
}

async function seedDropRaceState(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
      VALUES ($1, $2, $3, 'runtime-seal-race')
    `,
    [fixture.raceAgentId, fixture.clerkUserId, fixture.userOrgId],
  );
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, 'runtime-seal-race')
    `,
    [fixture.raceAgentId, fixture.userOrgId, fixture.clerkUserId],
  );
}

async function assertDropRaceDoesNotRollbackCanonicalMutation(
  client: Client,
  ddlClient: Client,
): Promise<void> {
  await seedDropRaceState(client);
  const db = drizzle(client);
  await db.transaction(async (tx) => {
    await tx.delete(agents).where(eq(agents.id, fixture.raceAgentId));

    // Test-only DDL deterministically gives the retiring schema the winning
    // side of the deployment race after canonical work has started but before
    // the old binary reaches its bounded legacy statement.
    await ddlClient.query(
      `ALTER TABLE "agent_composes" RENAME TO "agent_composes_runtime_absence_fixture"`,
    );
    await deleteLegacyAgentIdentitiesInTransaction(tx, {
      kind: "user",
      userId: fixture.clerkUserId,
      agentIds: [fixture.raceAgentId],
    });
  });

  const canonical = await client.query(
    `SELECT 1 FROM "agents" WHERE "id" = $1`,
    [fixture.raceAgentId],
  );
  assert.equal(canonical.rowCount, 0, "canonical delete must stay committed");
  const legacy = await client.query(
    `SELECT 1 FROM "agent_composes_runtime_absence_fixture" WHERE "id" = $1`,
    [fixture.raceAgentId],
  );
  assert.equal(legacy.rowCount, 1, "the DDL-winning legacy row remains opaque");
  const absent = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('public.agent_composes')::text AS "relation"`,
  );
  assert.deepEqual(absent.rows, [{ relation: null }]);
}

async function seedCanonicalLifecycleState(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES
        ($1, $3, $4, 'runtime-seal-user-agent'),
        ($2, $5, 'runtime-seal-org-owner', 'runtime-seal-org-agent')
    `,
    [
      fixture.userAgentId,
      fixture.orgAgentId,
      fixture.userOrgId,
      fixture.clerkUserId,
      fixture.clerkOrgId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_id"
      ) VALUES
        ($1, $3, $5, $7),
        ($2, $4, $6, $8)
    `,
    [
      fixture.userSessionId,
      fixture.orgSessionId,
      fixture.clerkUserId,
      "runtime-seal-org-runner",
      fixture.userOrgId,
      fixture.clerkOrgId,
      fixture.userAgentId,
      fixture.orgAgentId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id"
      ) VALUES
        ($1, $3, $5, 'completed', 'runtime seal user run', $7),
        ($2, $4, $6, 'completed', 'runtime seal org run', $8)
    `,
    [
      fixture.userRunId,
      fixture.orgRunId,
      fixture.clerkUserId,
      "runtime-seal-org-runner",
      fixture.userSessionId,
      fixture.orgSessionId,
      fixture.userOrgId,
      fixture.clerkOrgId,
    ],
  );
  await client.query(
    `
      INSERT INTO "storages" (
        "id", "user_id", "name", "org_id", "s3_prefix"
      ) VALUES ($1, $2, $3, $4, 'runtime-seal/instructions')
    `,
    [
      fixture.userStorageId,
      VOLUME_ORG_USER_ID,
      getInstructionsStorageName("runtime-seal-user-agent"),
      fixture.userOrgId,
    ],
  );
}

async function assertSchemaAbsentCanonicalLifecycle(
  client: Client,
): Promise<void> {
  await client.query(
    `ALTER TABLE "agent_compose_versions" RENAME TO "agent_compose_versions_runtime_absence_fixture"`,
  );
  await seedCanonicalLifecycleState(client);
  const db = drizzle(client);

  await deleteClerkAgentLifecycleData(db, {
    kind: "user",
    userId: fixture.clerkUserId,
  });
  await deleteClerkAgentLifecycleData(db, {
    kind: "user",
    userId: fixture.clerkUserId,
  });
  await deleteClerkAgentLifecycleData(db, {
    kind: "organization",
    orgId: fixture.clerkOrgId,
  });
  await deleteClerkAgentLifecycleData(db, {
    kind: "organization",
    orgId: fixture.clerkOrgId,
  });

  const lifecycleCounts = await client.query<{
    agents: number;
    sessions: number;
    runs: number;
    storages: number;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM "agents"
        WHERE "id" IN ('${fixture.userAgentId}', '${fixture.orgAgentId}')) AS "agents",
      (SELECT count(*)::integer FROM "agent_sessions"
        WHERE "id" IN ('${fixture.userSessionId}', '${fixture.orgSessionId}')) AS "sessions",
      (SELECT count(*)::integer FROM "agent_runs"
        WHERE "id" IN ('${fixture.userRunId}', '${fixture.orgRunId}')) AS "runs",
      (SELECT count(*)::integer FROM "storages"
        WHERE "id" = '${fixture.userStorageId}') AS "storages"
  `);
  assert.deepEqual(lifecycleCounts.rows, [
    { agents: 0, sessions: 0, runs: 0, storages: 0 },
  ]);

  await db.transaction(async (tx) => {
    await tx.insert(agents).values({
      id: fixture.privacyMarkerAgentId,
      orgId: fixture.userOrgId,
      owner: fixture.clerkUserId,
      name: "runtime-seal-privacy-marker",
    });
    await scrubLegacyAgentComposeVersionCreatorInTransaction(
      tx,
      fixture.clerkUserId,
    );
  });
  await db.transaction(async (tx) => {
    await scrubLegacyAgentComposeVersionCreatorInTransaction(
      tx,
      fixture.clerkUserId,
    );
  });
  const marker = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    fixture.privacyMarkerAgentId,
  ]);
  assert.equal(
    marker.rowCount,
    1,
    "schema-absent privacy cleanup must not roll back canonical work",
  );
}

export async function validateAgentSchemaAbsenceRuntimeSeal(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = databaseUrlFor(databaseUrl, "postgres");
  const testUrl = databaseUrlFor(databaseUrl, testDatabase);

  await resetDatabase(adminUrl, testDatabase);
  const client = await connect(testUrl);
  const ddlClient = await connect(testUrl);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      migration,
    );
    await assertSchemaPresentBoundary(client);
    await assertDropRaceDoesNotRollbackCanonicalMutation(client, ddlClient);
    await assertSchemaAbsentCanonicalLifecycle(client);
  } finally {
    await client.end();
    await ddlClient.end();
    const admin = await connect(adminUrl);
    try {
      await admin.query(
        `DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`,
      );
    } finally {
      await admin.end();
    }
  }

  console.log(
    "Agent schema-absence runtime seal passed (present, absent, and DDL-winning race)",
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentSchemaAbsenceRuntimeSeal().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
