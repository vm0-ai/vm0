#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";

const baseDatabaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return value;
})();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const migrationTag = "0978_remove_retired_agent_compose_plane";
const previousMigrationTag = "0977_rename_zero_debug_feature_switch_key";
const migrationPath = path.join(migrationsDirectory, `${migrationTag}.sql`);
const productionMigrationSql = await fs.readFile(migrationPath, "utf8");
const databasePrefix = `stage8_contraction_${process.pid}_${Date.now()}`;
const templateDatabase = `${databasePrefix}_template`;
const createdDatabases = new Set<string>();

const productionMemberDigests = [
  "113ad6becc69859c5d32951a5f1a1f0fa4ba80c0d3db8844aa7d03917265220a",
  "8dfd7409ac22987095db85e8d847b68b79ba5dd10061699a2cd8b342f0aa5a53",
  "9697088dede8e0c6d34e043d4e9195cb7f02eed78d03c3b5eaeffaf699a6cdad",
  "96eb4f5d3c590dc9576ebb780be44742b08936936b8230c1b80cb7c52179ae94",
  "da7f6e8f1e287573ecf9e04e7ae2c1f2cb6605f694cfeae4dd748a9ad86ef934",
  "e7bf22154afdeb95446d7be90a79f75813073581a292c334807ea37dd8adc37a",
] as const;
const productionSetDigest =
  "a83a3c8751fa88778aca7ac93b7d595a7e4c8e9e79cb08c9696ed1dd9e943b5c";

const artifactIds = Array.from({ length: 6 }, (_, index) => {
  return `00000000-0000-4000-8000-${String(980_001 + index).padStart(12, "0")}`;
});
const artifactSessionIds = Array.from({ length: 22 }, (_, index) => {
  return `00000000-0000-4000-8100-${String(980_001 + index).padStart(12, "0")}`;
});
const artifactRunIds = [
  "00000000-0000-4000-8200-000000980001",
  "00000000-0000-4000-8200-000000980002",
] as const;
const artifactThreadId = "00000000-0000-4000-8300-000000980001";
const canonicalAgentId = "00000000-0000-4000-8400-000000980001";
const canonicalSessionId = "00000000-0000-4000-8500-000000980001";
const canonicalRunId = "00000000-0000-4000-8600-000000980001";
const canonicalConversationId = "00000000-0000-4000-8700-000000980001";
const canonicalCheckpointId = "00000000-0000-4000-8800-000000980001";
const storageId = "00000000-0000-4000-8900-000000980001";
const usageEventId = "00000000-0000-4000-8a00-000000980001";
const usageRollupId = "00000000-0000-4000-8b00-000000980001";
const usageAllocationId = "00000000-0000-4000-8c00-000000980001";
const entitlementId = "00000000-0000-4000-8d00-000000980001";
const shortWindowId = "00000000-0000-4000-8e00-000000980001";
const weeklyWindowId = "00000000-0000-4000-8e00-000000980002";

function databaseUrlFor(database: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(database: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrlFor(database) });
  await client.connect();
  return client;
}

async function adminQuery(query: string): Promise<void> {
  const client = new Client({ connectionString: baseDatabaseUrl });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

async function dropDatabase(database: string): Promise<void> {
  await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  createdDatabases.delete(database);
}

async function createDatabase(
  database: string,
  template?: string,
): Promise<void> {
  await dropDatabase(database);
  await adminQuery(
    template
      ? `CREATE DATABASE "${database}" TEMPLATE "${template}"`
      : `CREATE DATABASE "${database}"`,
  );
  createdDatabases.add(database);
}

async function createPreviousSchemaTemplate(): Promise<void> {
  await createDatabase(templateDatabase);
  const client = await connect(templateDatabase);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigrationTag,
    );
  } finally {
    await client.end();
  }
}

async function withPreviousSchema(
  suffix: string,
  work: (database: string) => Promise<void>,
): Promise<void> {
  const database = `${databasePrefix}_${suffix}`;
  await createDatabase(database, templateDatabase);
  try {
    await work(database);
  } finally {
    await dropDatabase(database);
  }
}

function fingerprintMember(id: string): string {
  return createHash("sha256")
    .update("vm0:agent-compose-consolidation-preflight:v1")
    .update(Buffer.from([0]))
    .update("approved-artifact-member")
    .update(Buffer.from([0]))
    .update(`${Buffer.byteLength(id, "utf8")}:${id}`)
    .update(Buffer.from([0]))
    .digest("hex");
}

function fingerprintSet(ids: readonly string[]): string {
  const hash = createHash("sha256")
    .update("vm0:agent-compose-consolidation-preflight:v1")
    .update(Buffer.from([0]))
    .update("approved-artifact-set")
    .update(Buffer.from([0]));
  for (const id of [...ids].sort()) {
    hash.update(`${Buffer.byteLength(id, "utf8")}:${id}`);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function syntheticMigrationSql(): string {
  const syntheticMemberDigests = artifactIds.map(fingerprintMember).sort();
  let sql = productionMigrationSql;
  for (const [index, digest] of productionMemberDigests.entries()) {
    const replacement = syntheticMemberDigests[index];
    assert.ok(replacement);
    sql = sql.replaceAll(digest, replacement);
  }
  return sql.replaceAll(productionSetDigest, fingerprintSet(artifactIds));
}

async function runMigration(client: Client, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function expectMigrationFailure(
  client: Client,
  sql: string,
  expectedMessage: RegExp,
): Promise<void> {
  await assert.rejects(async () => {
    await runMigration(client, sql);
  }, expectedMessage);
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('public.agent_composes')::text AS "relation"`,
  );
  assert.equal(
    relation.rows[0]?.relation,
    "agent_composes",
    "a failed contraction must roll back every schema mutation",
  );
}

async function setFixtureBridgeTriggers(
  client: Client,
  enabled: boolean,
): Promise<void> {
  const action = enabled ? "ENABLE" : "DISABLE";
  const triggers = [
    ["agent_composes", "bridge_agent_composes_to_agents_0966"],
    ["zero_agents", "bridge_zero_agents_to_agents_0966"],
    ["agent_sessions", "bridge_agent_sessions_agent_reference_0966"],
    ["chat_threads", "bridge_chat_threads_agent_reference_0966"],
    ["chat_thread_events", "bridge_chat_thread_events_agent_reference_0966"],
    [
      "chat_event_search_messages",
      "bridge_chat_event_search_agent_reference_0966",
    ],
    [
      "slack_user_agent_preferences",
      "bridge_slack_preferences_agent_reference_0966",
    ],
  ] as const;
  for (const [table, trigger] of triggers) {
    await client.query(`ALTER TABLE "${table}" ${action} TRIGGER "${trigger}"`);
  }
}

async function seedApprovedClosure(
  client: Client,
  options: { readonly runStatus?: "completed" | "running" } = {},
): Promise<void> {
  const runStatus = options.runStatus ?? "completed";
  await client.query("BEGIN");
  try {
    await setFixtureBridgeTriggers(client, false);
    await client.query(
      `
        INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
        SELECT "id", 'stage8-artifact-user', 'stage8-artifact-org',
          'stage8-artifact-' || "ordinality"::text
        FROM unnest($1::uuid[]) WITH ORDINALITY AS "artifact"("id", "ordinality")
      `,
      [artifactIds],
    );

    const versionIds = Array.from({ length: 7 }, (_, index) => {
      return String(index + 1)
        .repeat(64)
        .slice(0, 64);
    });
    const versionArtifactIds = [artifactIds[0], ...artifactIds];
    await client.query(
      `
        INSERT INTO "agent_compose_versions" (
          "id", "compose_id", "content", "created_by"
        )
        SELECT "version_id", "artifact_id", '{"fixture":true}'::jsonb,
          'stage8-artifact-user'
        FROM unnest($1::text[], $2::uuid[])
          AS "version"("version_id", "artifact_id")
      `,
      [versionIds, versionArtifactIds],
    );

    const sessionArtifactIds = artifactSessionIds.map((_, index) => {
      return artifactIds[index % artifactIds.length];
    });
    await client.query(
      `
        INSERT INTO "agent_sessions" (
          "id", "user_id", "org_id", "agent_compose_id"
        )
        SELECT "session_id", 'stage8-artifact-user', 'stage8-artifact-org',
          "artifact_id"
        FROM unnest($1::uuid[], $2::uuid[])
          AS "session"("session_id", "artifact_id")
      `,
      [artifactSessionIds, sessionArtifactIds],
    );

    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "status", "prompt", "user_id", "org_id", "session_id",
          "agent_compose_version_id"
        ) VALUES
          ($1, $3, 'stage8 artifact fixture', 'stage8-artifact-user',
            'stage8-artifact-org', $4, $6),
          ($2, $3, 'stage8 artifact fixture', 'stage8-artifact-user',
            'stage8-artifact-org', $5, $7)
      `,
      [
        artifactRunIds[0],
        artifactRunIds[1],
        runStatus,
        artifactSessionIds[0],
        artifactSessionIds[1],
        versionIds[0],
        versionIds[1],
      ],
    );

    await client.query(
      `
        INSERT INTO "chat_threads" (
          "id", "user_id", "agent_compose_id", "title"
        ) VALUES ($1, 'stage8-artifact-user', $2, 'stage8 artifact fixture')
      `,
      [artifactThreadId, artifactIds[0]],
    );
    await client.query(
      `
        INSERT INTO "chat_event_search_messages" (
          "chat_thread_id", "seq_id", "user_id", "org_id",
          "agent_compose_id", "role", "created_at", "text", "text_bigram"
        ) VALUES
          ($1, 1, 'stage8-artifact-user', 'stage8-artifact-org', $2,
            'user', now(), 'fixture', 'fixture'),
          ($1, 2, 'stage8-artifact-user', 'stage8-artifact-org', $2,
            'assistant', now(), 'fixture', 'fixture')
      `,
      [artifactThreadId, artifactIds[0]],
    );

    const conversations = artifactRunIds.map((_, index) => {
      return `00000000-0000-4000-9000-${String(980_001 + index).padStart(12, "0")}`;
    });
    const checkpoints = artifactRunIds.map((_, index) => {
      return `00000000-0000-4000-9100-${String(980_001 + index).padStart(12, "0")}`;
    });
    await client.query(
      `
        INSERT INTO "conversations" (
          "id", "run_id", "cli_agent_type", "cli_agent_session_id"
        )
        SELECT "conversation_id", "run_id", 'claude-code',
          'stage8-artifact-session'
        FROM unnest($1::uuid[], $2::uuid[])
          AS "conversation"("conversation_id", "run_id")
      `,
      [conversations, artifactRunIds],
    );
    await client.query(
      `
        INSERT INTO "checkpoints" (
          "id", "run_id", "conversation_id", "agent_compose_snapshot",
          "storage_mounts"
        )
        SELECT "checkpoint_id", "run_id", "conversation_id",
          '{"fixture":true}'::jsonb, '{"fixture":true}'::jsonb
        FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
          AS "checkpoint"("checkpoint_id", "run_id", "conversation_id")
      `,
      [checkpoints, artifactRunIds, conversations],
    );

    await seedProtectedHistory(client);
    await seedArtifactBilling(client);
    await setFixtureBridgeTriggers(client, true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedProtectedHistory(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, 'stage8-protected-org', 'stage8-protected-user',
        'stage8-protected-agent')
    `,
    [canonicalAgentId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" ("id", "user_id", "org_id", "agent_id")
      VALUES ($1, 'stage8-protected-user', 'stage8-protected-org', $2)
    `,
    [canonicalSessionId, canonicalAgentId],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "status", "prompt", "user_id", "org_id", "session_id",
        "launch_snapshot"
      ) VALUES (
        $1, 'completed', 'stage8 protected fixture', 'stage8-protected-user',
        'stage8-protected-org', $2,
        '{"schemaVersion":1,"framework":"claude-code","runnerProfile":"default"}'::jsonb
      )
    `,
    [canonicalRunId, canonicalSessionId],
  );
  await client.query(
    `
      INSERT INTO "conversations" (
        "id", "run_id", "cli_agent_type", "cli_agent_session_id"
      ) VALUES ($1, $2, 'claude-code', 'stage8-protected-session')
    `,
    [canonicalConversationId, canonicalRunId],
  );
  await client.query(
    `
      INSERT INTO "checkpoints" (
        "id", "run_id", "conversation_id", "storage_mounts"
      ) VALUES ($1, $2, $3, '{"protected":true}'::jsonb)
    `,
    [canonicalCheckpointId, canonicalRunId, canonicalConversationId],
  );
  await client.query(
    `
      INSERT INTO "storages" (
        "id", "user_id", "org_id", "name", "s3_prefix"
      ) VALUES ($1, 'stage8-protected-user', 'stage8-protected-org',
        'stage8-protected-storage', 'stage8/protected/storage')
    `,
    [storageId],
  );
  await client.query(
    `
      INSERT INTO "storage_versions" (
        "id", "storage_id", "s3_key", "created_by", "archive_size"
      ) VALUES ($1, $2, 'stage8/protected/storage/version',
        'stage8-protected-user', 1)
    `,
    ["f".repeat(64), storageId],
  );

  const anchorEventIds = Array.from({ length: 27 }, (_, index) => {
    return `00000000-0000-4000-9200-${String(980_001 + index).padStart(12, "0")}`;
  });
  const missingThreadIds = Array.from({ length: 27 }, (_, index) => {
    return `00000000-0000-4000-9300-${String(980_001 + index).padStart(12, "0")}`;
  });
  const missingAgentIds = Array.from({ length: 27 }, (_, index) => {
    return `00000000-0000-4000-9400-${String(980_001 + index).padStart(12, "0")}`;
  });
  for (const [index, eventId] of anchorEventIds.entries()) {
    const userId = `stage8-anchor-user-${index}`;
    const orgId = `stage8-anchor-org-${index}`;
    await client.query(
      `
        INSERT INTO "chat_thread_events" (
          "id", "user_id", "org_id", "chat_thread_id", "kind",
          "agent_compose_id", "seq_id"
        ) VALUES ($1, $2, $3, $4, 'deleted', $5, 1)
      `,
      [eventId, userId, orgId, missingThreadIds[index], missingAgentIds[index]],
    );
    await client.query(
      `
        INSERT INTO "chat_thread_snapshots" (
          "user_id", "org_id", "latest_event_id", "chat_threads",
          "latest_event_seq_id"
        ) VALUES ($1, $2, $3, '[]'::jsonb, 1)
      `,
      [userId, orgId, eventId],
    );
  }
}

async function seedArtifactBilling(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "org_usage_allowance_entitlements" (
        "id", "org_id", "short_window_seconds", "short_window_units",
        "weekly_window_units"
      ) VALUES ($1, 'stage8-artifact-org', 3600, 100, 1000)
    `,
    [entitlementId],
  );
  await client.query(
    `
      INSERT INTO "org_usage_allowance_windows" (
        "id", "org_id", "entitlement_id", "kind", "starts_at",
        "expires_at", "unit_limit", "created_by_run_id"
      ) VALUES
        ($1, 'stage8-artifact-org', $3, 'short',
          date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour',
          100, $4),
        ($2, 'stage8-artifact-org', $3, 'weekly',
          date_trunc('hour', now()), date_trunc('hour', now()) + interval '7 days',
          1000, $4)
    `,
    [shortWindowId, weeklyWindowId, entitlementId, artifactRunIds[0]],
  );
  await client.query(
    `
      INSERT INTO "usage_event" (
        "id", "run_id", "idempotency_key", "org_id", "user_id", "kind",
        "provider", "category", "quantity", "credits_charged", "status"
      ) VALUES ($1, $2, $3, 'stage8-artifact-org', 'stage8-artifact-user',
        'model', 'fixture', 'tokens', 10, 1, 'processed')
    `,
    [usageEventId, artifactRunIds[0], "00000000-0000-4000-9500-000000980001"],
  );
  await client.query(
    `
      INSERT INTO "usage_allowance_allocations" (
        "id", "usage_event_id", "org_id", "run_id", "short_window_id",
        "weekly_window_id", "units_applied"
      ) VALUES ($1, $2, 'stage8-artifact-org', $3, $4, $5, 1)
    `,
    [
      usageAllocationId,
      usageEventId,
      artifactRunIds[0],
      shortWindowId,
      weeklyWindowId,
    ],
  );
  await client.query(
    `
      INSERT INTO "usage_event_hourly_rollup" (
        "id", "processed_hour", "org_id", "user_id", "run_id", "kind",
        "provider", "category", "short_window_id", "weekly_window_id",
        "quantity", "credits_charged", "allowance_units"
      ) VALUES ($1, date_trunc('hour', now()), 'stage8-artifact-org',
        'stage8-artifact-user', $2, 'model', 'fixture', 'tokens', $3, $4,
        10, 1, 1)
    `,
    [usageRollupId, artifactRunIds[0], shortWindowId, weeklyWindowId],
  );
}

async function assertFinalState(client: Client): Promise<void> {
  const legacyRelations = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM pg_class
    WHERE oid IN (
      to_regclass('public.agent_composes'),
      to_regclass('public.agent_compose_versions'),
      to_regclass('public.zero_agents')
    )
  `);
  assert.equal(legacyRelations.rows[0]?.count, 0);

  const legacyColumns = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN (
        'agent_compose_id', 'agent_compose_version_id',
        'agent_compose_snapshot', 'default_compose_id', 'selected_compose_id'
      )
  `);
  assert.equal(legacyColumns.rows[0]?.count, 0);

  const protectedRows = await client.query<{
    agentCount: number;
    sessionCount: number;
    runCount: number;
    checkpointCount: number;
    storageCount: number;
    storageVersionCount: number;
    anchorCount: number;
  }>(
    `
      SELECT
        (SELECT count(*)::integer FROM "agents" WHERE "id" = $1) AS "agentCount",
        (SELECT count(*)::integer FROM "agent_sessions" WHERE "id" = $2) AS "sessionCount",
        (SELECT count(*)::integer FROM "agent_runs"
          WHERE "id" = $3 AND "launch_snapshot" IS NOT NULL) AS "runCount",
        (SELECT count(*)::integer FROM "checkpoints"
          WHERE "id" = $4 AND "storage_mounts" = '{"protected":true}'::jsonb)
          AS "checkpointCount",
        (SELECT count(*)::integer FROM "storages" WHERE "id" = $5) AS "storageCount",
        (SELECT count(*)::integer FROM "storage_versions" WHERE "storage_id" = $5)
          AS "storageVersionCount",
        (SELECT count(*)::integer FROM "chat_thread_events"
          WHERE "id"::text LIKE '00000000-0000-4000-9200-%'
            AND "agent_id" IS NULL) AS "anchorCount"
    `,
    [
      canonicalAgentId,
      canonicalSessionId,
      canonicalRunId,
      canonicalCheckpointId,
      storageId,
    ],
  );
  assert.deepEqual(protectedRows.rows, [
    {
      agentCount: 1,
      sessionCount: 1,
      runCount: 1,
      checkpointCount: 1,
      storageCount: 1,
      storageVersionCount: 1,
      anchorCount: 27,
    },
  ]);

  const billing = await client.query<{
    usageEventRunId: string | null;
    rollupRunId: string | null;
    allocationRunId: string | null;
    shortWindowRunId: string | null;
    weeklyWindowRunId: string | null;
  }>(
    `
      SELECT
        (SELECT "run_id"::text FROM "usage_event" WHERE "id" = $1)
          AS "usageEventRunId",
        (SELECT "run_id"::text FROM "usage_event_hourly_rollup" WHERE "id" = $2)
          AS "rollupRunId",
        (SELECT "run_id"::text FROM "usage_allowance_allocations" WHERE "id" = $3)
          AS "allocationRunId",
        (SELECT "created_by_run_id"::text FROM "org_usage_allowance_windows"
          WHERE "id" = $4) AS "shortWindowRunId",
        (SELECT "created_by_run_id"::text FROM "org_usage_allowance_windows"
          WHERE "id" = $5) AS "weeklyWindowRunId"
    `,
    [
      usageEventId,
      usageRollupId,
      usageAllocationId,
      shortWindowId,
      weeklyWindowId,
    ],
  );
  assert.deepEqual(billing.rows, [
    {
      usageEventRunId: null,
      rollupRunId: null,
      allocationRunId: null,
      shortWindowRunId: null,
      weeklyWindowRunId: null,
    },
  ]);
}

function assertStaticBoundary(): void {
  assert.ok(
    !productionMigrationSql.includes(NON_TRANSACTIONAL_MIGRATION_MARKER),
  );
  assert.doesNotMatch(productionMigrationSql, /\bCASCADE\b/u);
  assert.doesNotMatch(productionMigrationSql, /\bLOCK\s+TABLE\b/u);
  assert.match(
    productionMigrationSql,
    /01390c8ae78016cf5cb60f7cf50ee70d5400e4a4/u,
  );
  assert.match(productionMigrationSql, /2026-08-24T04:29:03Z/u);
  assert.match(productionMigrationSql, /issuecomment-5390865017/u);
  for (const digest of productionMemberDigests) {
    assert.equal(productionMigrationSql.split(digest).length - 1, 2);
  }
  assert.equal(productionMigrationSql.split(productionSetDigest).length - 1, 2);
  assert.match(productionMigrationSql, /manifest_count <> 86/u);
  assert.match(
    productionMigrationSql,
    /d0d6ebbdcab2e8c1abf6d3997fe14bb9b9e32704ef12f10e017a9dec1e9f19c8/u,
  );
  assert.match(
    productionMigrationSql,
    /"not_null_constraint"\."contype" = 'n'/u,
  );
  assert.match(productionMigrationSql, /canonical_fk_count <> 18/u);
  assert.match(productionMigrationSql, /canonical_index_count <> 8/u);
  assert.match(productionMigrationSql, /closure_fk_count <> 51/u);
}

async function validateFreshEmptyAndNonEmptyGates(): Promise<void> {
  await withPreviousSchema("fresh_empty", async (database) => {
    const client = await connect(database);
    try {
      await runMigration(client, productionMigrationSql);
      await assertFinalCatalogOnly(client);
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("nonempty_without_six", async (database) => {
    const client = await connect(database);
    try {
      await client.query(
        `INSERT INTO "agents" ("id", "org_id", "owner", "name")
         VALUES ($1, 'stage8-drift-org', 'stage8-drift-user', 'stage8-drift')`,
        [canonicalAgentId],
      );
      await expectMigrationFailure(
        client,
        productionMigrationSql,
        /approved artifact identity drift/u,
      );
    } finally {
      await client.end();
    }
  });
}

async function assertFinalCatalogOnly(client: Client): Promise<void> {
  const result = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('agent_composes', 'agent_compose_versions', 'zero_agents')
  `);
  assert.equal(result.rows[0]?.count, 0);
}

async function validateFailClosedDriftGates(): Promise<void> {
  await withPreviousSchema("set_drift", async (database) => {
    const client = await connect(database);
    try {
      await setFixtureBridgeTriggers(client, false);
      await client.query(
        `INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
         VALUES ($1, 'stage8-drift-user', 'stage8-drift-org', 'stage8-drift')`,
        [artifactIds[0]],
      );
      await setFixtureBridgeTriggers(client, true);
      await expectMigrationFailure(
        client,
        productionMigrationSql,
        /approved artifact identity drift/u,
      );
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("catalog_drift", async (database) => {
    const client = await connect(database);
    try {
      await client.query(
        `CREATE VIEW "stage8_unexpected_dependency" AS
         SELECT "id" FROM "agent_composes"`,
      );
      await expectMigrationFailure(
        client,
        productionMigrationSql,
        /catalog removal manifest drift/u,
      );
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("canonical_fk_drift", async (database) => {
    const client = await connect(database);
    try {
      await client.query(
        `ALTER TABLE "agent_sessions"
         DROP CONSTRAINT "agent_sessions_agent_id_agents_id_fk"`,
      );
      await expectMigrationFailure(
        client,
        productionMigrationSql,
        /canonical Agent FK manifest drift/u,
      );
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("active_run", async (database) => {
    const client = await connect(database);
    try {
      await seedApprovedClosure(client, { runStatus: "running" });
      await expectMigrationFailure(
        client,
        syntheticMigrationSql(),
        /non-completed Run/u,
      );
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("preference", async (database) => {
    const client = await connect(database);
    try {
      await seedApprovedClosure(client);
      await client.query(
        `ALTER TABLE "slack_user_agent_preferences"
         DISABLE TRIGGER "bridge_slack_preferences_agent_reference_0966"`,
      );
      await client.query(
        `INSERT INTO "slack_user_agent_preferences" (
          "org_id", "user_id", "selected_compose_id"
         ) VALUES ('stage8-artifact-org', 'stage8-preference-user', $1)`,
        [artifactIds[0]],
      );
      await client.query(
        `ALTER TABLE "slack_user_agent_preferences"
         ENABLE TRIGGER "bridge_slack_preferences_agent_reference_0966"`,
      );
      await expectMigrationFailure(
        client,
        syntheticMigrationSql(),
        /default\/preference\/install reference/u,
      );
    } finally {
      await client.end();
    }
  });
}

async function validateBillingRollback(): Promise<void> {
  await withPreviousSchema("billing_rollback", async (database) => {
    const client = await connect(database);
    try {
      await seedApprovedClosure(client);
      await client.query(`
        CREATE FUNCTION "stage8_delete_usage_fixture"() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          DELETE FROM "usage_event" WHERE "run_id" = OLD."id";
          RETURN OLD;
        END
        $$
      `);
      await client.query(`
        CREATE TRIGGER "stage8_delete_usage_fixture"
        BEFORE DELETE ON "agent_runs"
        FOR EACH ROW EXECUTE FUNCTION "stage8_delete_usage_fixture"()
      `);
      await expectMigrationFailure(
        client,
        syntheticMigrationSql(),
        /billing\/usage retention drift/u,
      );
      const billing = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "usage_event" WHERE "id" = $1`,
        [usageEventId],
      );
      assert.equal(billing.rows[0]?.count, 1);
    } finally {
      await client.end();
    }
  });
}

async function validateExactCleanupAndLockRetry(): Promise<void> {
  await withPreviousSchema("exact_cleanup", async (database) => {
    const client = await connect(database);
    try {
      await seedApprovedClosure(client);
      await runMigration(client, syntheticMigrationSql());
      await assertFinalState(client);
    } finally {
      await client.end();
    }
  });

  await withPreviousSchema("lock_retry", async (database) => {
    const client = await connect(database);
    const lockClient = await connect(database);
    try {
      await seedApprovedClosure(client);
      await lockClient.query("BEGIN");
      await lockClient.query(`SELECT 1 FROM "agent_composes" LIMIT 1`);
      await expectMigrationFailure(
        client,
        syntheticMigrationSql(),
        /lock timeout|canceling statement due to lock timeout/u,
      );
      const artifactsAfterRollback = await client.query<{ count: number }>(
        `
        SELECT count(*)::integer AS "count" FROM "agent_composes"
        WHERE "id" = ANY($1::uuid[])
      `,
        [artifactIds],
      );
      assert.equal(artifactsAfterRollback.rows[0]?.count, 6);

      await lockClient.query("ROLLBACK");
      await runMigration(client, syntheticMigrationSql());
      await assertFinalState(client);
    } finally {
      await lockClient.query("ROLLBACK").catch(() => {
        return undefined;
      });
      await lockClient.end();
      await client.end();
    }
  });
}

async function validateFullFreshMigration(): Promise<void> {
  const database = `${databasePrefix}_full_fresh`;
  await createDatabase(database);
  const client = await connect(database);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      migrationTag,
    );
    await assertFinalCatalogOnly(client);
  } finally {
    await client.end();
    await dropDatabase(database);
  }
}

async function main(): Promise<void> {
  assertStaticBoundary();
  await createPreviousSchemaTemplate();
  await validateFreshEmptyAndNonEmptyGates();
  await validateFailClosedDriftGates();
  await validateBillingRollback();
  await validateExactCleanupAndLockRetry();
  await validateFullFreshMigration();
  console.log("Retired Agent persistence contraction validated");
}

try {
  await main();
} finally {
  for (const database of [...createdDatabases].reverse()) {
    await dropDatabase(database).catch(() => {
      return undefined;
    });
  }
}
