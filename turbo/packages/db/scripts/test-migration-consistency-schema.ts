#!/usr/bin/env tsx
/**
 * Migration Consistency Test - Schema Comparison
 *
 * This script verifies that all migration files match the schema definitions
 * by comparing the final database state using normalized comparison.
 *
 * Steps:
 * 1. Create test database and run existing migrations
 * 2. Create test database, regenerate migrations from schema and run them
 * 3. Compare schemas using normalized comparison (ignores benign differences)
 *
 * Note: Uses pg library for all database operations (no pg_dump/psql required)
 *
 * IMPORTANT: Migration Best Practices
 * ===================================
 *
 * ❌ NEVER manually write migration files!
 * ❌ NEVER edit existing migration files!
 * ❌ NEVER manually create snapshot files!
 *
 * ✅ ALWAYS use `pnpm -F @okouai/db db:generate` to auto-generate migrations
 * ✅ ALWAYS let Drizzle Kit manage the snapshot system
 * ✅ ALWAYS test with `pnpm test:migration-consistency` before merging
 *
 * Manual migrations break the snapshot chain and cause this test to fail.
 * If this test fails, follow the fix instructions in the error message.
 */

import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "../src/schema/chat-event";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { validateAgentDraftsCompatibilityRelation } from "./test-agent-drafts-compatibility-relation";
import {
  CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_FUNCTION,
  CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_TRIGGER,
  validateChatSearchDeleteCompatibility,
} from "./test-chat-search-delete-compatibility";
import { validateAgentRunMetadataStage2Index } from "./test-agent-run-metadata-stage-2-index";
import {
  validateAgentRunMetadataStage2Final,
  validateAgentRunMetadataStage2Runner,
} from "./test-agent-run-metadata-stage-2-final";
import { validateAgentRunMetadataStage2Lock } from "./test-agent-run-metadata-stage-2-lock";
import { validateAgentRunMetadataStage2Preflight } from "./test-agent-run-metadata-stage-2-preflight";
import {
  validateAgentRunLaunchSnapshotMigration,
  validateAgentRunLaunchSnapshotSchema,
} from "./test-agent-run-launch-snapshot";
import { validateAgentRunOfficialWorkflowProvenanceSchema } from "./test-agent-run-official-workflow-provenance";
import {
  validateOfficialAutomationResultEmailMigration,
  validateOfficialAutomationResultEmailSchema,
} from "./test-official-automation-result-email-schema";
import { validatePermanentAgentRunBuiltInModelKeyState } from "./test-agent-run-built-in-model-key-permanent";
import { validatePermanentBuiltInModelCooldownState } from "./test-built-in-model-cooldown-permanent";
import { validatePermanentBuiltInModelKeyState } from "./test-built-in-model-keys-permanent";
import { validatePermanentBuiltInProviderDiscriminatorState } from "./test-built-in-provider-discriminator-permanent";
import { validateBuiltInProviderDiscriminatorMigration } from "./test-built-in-provider-discriminator-migration";
import { validateConnectorAccountExpansion } from "./test-connector-account-expansion";
import { validateConnectorAuthorizationAccountMutationPresence } from "./test-connector-authorization-account-mutation-presence";
import { validateCustomGatewayProviderTypes } from "./test-custom-gateway-provider-types";
import { validateFeishuMemberConnectorReconciliation } from "./test-feishu-member-connector-reconciliation";
import { validateOkouDebugFeatureSwitchKeyRename } from "./test-okou-debug-feature-switch-key-rename";
import {
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_MIGRATION,
  validateOrgMetadataAcquisitionFirstPartySourceBackfill,
  validateOrgMetadataAcquisitionFirstPartySourceBackfillOnRegeneratedSchema,
} from "./test-org-metadata-acquisition-first-party-source-backfill";
import { validateOrgMetadataAcquisitionFirstPartySourceExpansion } from "./test-org-metadata-acquisition-first-party-source-expansion";
import {
  installOrgMetadataAcquisitionFirstPartySourceArtifactsOnRegeneratedSchema,
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION,
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION,
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER,
  validatePermanentOrgMetadataAcquisitionFirstPartySourceState,
} from "./test-org-metadata-acquisition-first-party-source-permanent";
import { validateOrgPlanEntitlementRestrictionExpansion } from "./test-org-plan-entitlement-restriction-expansion";
import {
  ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_MIGRATION,
  validateOrgPlanEntitlementRestrictionBackfill,
  validateOrgPlanEntitlementRestrictionBackfillOnRegeneratedSchema,
} from "./test-org-plan-entitlement-restriction-backfill";
import { validateOrgPlanEntitlementRestrictionNotNull } from "./test-org-plan-entitlement-restriction-not-null";
import {
  installOrgPlanEntitlementRestrictionArtifactsOnRegeneratedSchema,
  ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER,
  validatePermanentOrgPlanEntitlementRestrictionState,
} from "./test-org-plan-entitlement-restriction-permanent";
import { validateSlackOfficialBrandMigration } from "./test-slack-official-brand-migration";
import { validatePermanentSlackPublicBrandState } from "./test-slack-public-brand-permanent";
import { validateWorkflowCompatibilityViews } from "./test-workflow-compatibility-views";
import { LEGACY_DATABASE_IDENTITY_MANIFEST } from "./legacy-database-identity-manifest";
import {
  assertLegacyDatabaseIdentityInventory,
  countLegacyIdentitiesByKind,
  discoverLatestLegacySnapshotIdentities,
  discoverPersistedSemanticLegacyIdentities,
  discoverReplayedCatalogLegacyIdentities,
} from "./legacy-database-identity-inventory";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(dirname, "..");
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, "src/migrations");
const BACKUP_DIR = path.join(dirname, "../.migrations-backup");
const RESTORE_DIR = path.join(dirname, "../.migrations-restore");

// Parse DATABASE_URL to get connection details
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const dbUrl = new URL(DATABASE_URL);
const DB_HOST = dbUrl.hostname;
const DB_PORT = dbUrl.port;
const DB_USER = dbUrl.username;
const DB_PASSWORD = dbUrl.password;

function createTestDbUrl(dbName: string): string {
  const auth = DB_PASSWORD ? `${DB_USER}:${DB_PASSWORD}` : DB_USER;
  return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

function execCommand(
  cmd: string,
  options?: { env?: Record<string, string>; cwd?: string },
): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });
}

async function executeOnPostgres(sql: string): Promise<void> {
  const client = new Client({
    host: DB_HOST,
    port: parseInt(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: "postgres", // Connect to default postgres database
  });

  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(dbName: string): Promise<void> {
  console.log(`📦 Creating database: ${dbName}`);
  try {
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  } catch {
    // Database might already exist, try to drop and recreate
    console.log(`   Database exists, dropping and recreating...`);
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  }
}

async function dropDatabase(dbName: string): Promise<void> {
  console.log(`🗑️  Dropping database: ${dbName}`);
  try {
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    console.warn(`   Warning: Failed to drop database ${dbName}`);
  }
}

async function runMigrations(dbUrl: string): Promise<void> {
  console.log(`🔨 Running migrations...`);
  execCommand(`tsx ${path.join(dirname, "migrate.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function resetDatabase(dbUrl: string): Promise<void> {
  console.log(`♻️  Resetting database...`);
  execCommand(`tsx ${path.join(dirname, "reset-db.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function applyMigrationsUpToTag(
  client: Client,
  upToTag: string,
): Promise<void> {
  await applyMigrationsFromDirectoryUpToTag(client, MIGRATIONS_DIR, upToTag);
}

async function runMigrationsUpToTag(
  dbUrl: string,
  upToTag: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await applyMigrationsUpToTag(client, upToTag);
  } finally {
    await client.end();
  }
}

async function validateExpandedBrowserSchema(dbUrl: string): Promise<void> {
  console.log("=== Phase 2.4: Validate expanded browser schema ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const tables = await client.query<{
      browserProfiles: string | null;
      tabSnapshots: string | null;
    }>(
      `
        SELECT
          to_regclass('public.browser_profiles')::text AS "browserProfiles",
          to_regclass('public.browser_session_tab_snapshots')::text
            AS "tabSnapshots"
      `,
    );
    // The retired browser table stays until the pre-cleanup API drains; the
    // follow-up contraction release drops it together with its declaration.
    assert.deepEqual(tables.rows, [
      {
        browserProfiles: "browser_profiles",
        tabSnapshots: "browser_session_tab_snapshots",
      },
    ]);

    const retiredColumns = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('browser_sessions', 'id'),
            ('browser_sessions', 'browser_profile_id'),
            ('browser_session_instances', 'browser_session_id'),
            ('browser_thread_profiles', 'id')
          )
      `,
    );
    // Same two-release contract: the declarations and physical columns are
    // dropped together only after this release has drained.
    assert.deepEqual(retiredColumns.rows, [{ count: 4 }]);

    const primaryKeys = await client.query<{
      columnName: string;
      tableName: string;
    }>(
      `
        SELECT
          "tc"."table_name" AS "tableName",
          "kcu"."column_name" AS "columnName"
        FROM "information_schema"."table_constraints" AS "tc"
        INNER JOIN "information_schema"."key_column_usage" AS "kcu"
          ON "tc"."constraint_name" = "kcu"."constraint_name"
          AND "tc"."table_schema" = "kcu"."table_schema"
        WHERE "tc"."table_schema" = 'public'
          AND "tc"."constraint_type" = 'PRIMARY KEY'
          AND "tc"."table_name" IN (
            'browser_sessions',
            'browser_thread_profiles'
          )
        ORDER BY "tc"."table_name", "kcu"."ordinal_position"
      `,
    );
    // Current code keys every lookup by chat_thread_id, but the physical
    // primary key stays on the retired identity column for this release.
    assert.deepEqual(primaryKeys.rows, [
      { tableName: "browser_sessions", columnName: "id" },
      { tableName: "browser_thread_profiles", columnName: "id" },
    ]);

    const lifecycleConstraint = await client.query<{ definition: string }>(
      `
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `,
    );
    assert.equal(lifecycleConstraint.rows.length, 1);
    const lifecycleDefinition = lifecycleConstraint.rows[0]?.definition ?? "";
    // Only the canonical lifecycle values remain after the old API drain.
    assert.match(lifecycleDefinition, /browser\.open/u);
    assert.match(lifecycleDefinition, /browser\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.started/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.stopped/u);
    assert.match(lifecycleDefinition, /goal\.open/u);
    assert.match(lifecycleDefinition, /goal\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /goal\.changed/u);
    console.log(
      "   ✅ retired browser tables and identity columns still exist",
    );
    console.log(
      "   ✅ browser lifecycle and goal event constraints are canonical\n",
    );
  } finally {
    await client.end();
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectAppendOnlyUpdateRejected(
  client: Client,
  args: {
    readonly tableName: "chat_events" | "chat_messages" | "chat_thread_events";
    readonly query: string;
    readonly rowId: string;
  },
): Promise<void> {
  try {
    await client.query(args.query, [args.rowId]);
  } catch (error) {
    const expectedMessage = `${args.tableName} is append-only; UPDATE is not allowed`;
    if (
      databaseErrorCode(error) === "P0001" &&
      error instanceof Error &&
      error.message.includes(expectedMessage)
    ) {
      return;
    }
    throw error;
  }

  throw new Error(`${args.tableName} accepted an UPDATE`);
}

async function assertChatEventsAppendOnlyProtection(
  client: Client,
  rowId: string,
): Promise<void> {
  const triggers = await client.query<{
    enabled: string;
    triggerName: string;
  }>(`
    SELECT
      "tgname" AS "triggerName",
      "tgenabled"::text AS "enabled"
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND NOT "tgisinternal"
  `);
  assert.deepEqual(triggers.rows, [
    { enabled: "O", triggerName: "chat_events_reject_update" },
  ]);
  await expectAppendOnlyUpdateRejected(client, {
    tableName: "chat_events",
    query: `UPDATE "chat_events" SET "event_type" = "event_type" WHERE "id" = $1`,
    rowId,
  });
}

async function validateCanonicalChatMessageStorage(
  client: Client,
  threadId: string,
): Promise<string> {
  const sequenceReservation = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 2
      WHERE "id" = $1
      RETURNING "last_chat_event_seq_id" AS "lastSeqId"
    `,
    [threadId],
  );
  const lastSeqId = Number(sequenceReservation.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(lastSeqId));
  const firstSeqId = lastSeqId - 1;
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API migration test" }],
  };
  const message = await client.query<{
    contextType: string | null;
    id: string;
    payload: unknown;
    seqId: string;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "context_type",
        "event_type",
        "payload",
        "seq_id"
      )
      VALUES (
        $1,
        'web',
        'input.prompt',
        $3::jsonb,
        $2
      )
      RETURNING
        "id",
        "seq_id" AS "seqId",
        "context_type" AS "contextType",
        "payload"
    `,
    [threadId, firstSeqId, JSON.stringify({ userMessage })],
  );
  const messageRow = message.rows[0];
  if (!messageRow) {
    throw new Error("Failed to create append-only chat message fixture");
  }
  assert.equal(messageRow.seqId, String(firstSeqId));
  assert.equal(messageRow.contextType, "web");
  assert.deepEqual(messageRow.payload, { userMessage });

  const nextMessage = await client.query<{
    payload: unknown;
    seqId: string;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "event_type",
        "payload",
        "seq_id"
      )
      VALUES (
        $1,
        'output.message',
        '{"content":"second typed API migration test"}'::jsonb,
        $2
      )
      RETURNING
        "seq_id" AS "seqId",
        "payload"
    `,
    [threadId, lastSeqId],
  );
  assert.equal(nextMessage.rows[0]?.seqId, String(lastSeqId));
  assert.deepEqual(nextMessage.rows[0]?.payload, {
    content: "second typed API migration test",
  });

  const sequenceState = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_event_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [threadId],
  );
  assert.equal(sequenceState.rows[0]?.lastSeqId, String(lastSeqId));

  return messageRow.id;
}

async function validateCanonicalDraftStorage(
  client: Client,
  threadId: string,
): Promise<void> {
  const draftUserMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API draft" }],
  };
  const canonicalDraft = await client.query<{
    draftUserMessage: unknown;
  }>(
    `
      UPDATE "chat_threads"
      SET "draft_user_message" = $2::jsonb
      WHERE "id" = $1
      RETURNING
        "draft_user_message" AS "draftUserMessage"
    `,
    [threadId, JSON.stringify(draftUserMessage)],
  );
  assert.deepEqual(canonicalDraft.rows[0]?.draftUserMessage, draftUserMessage);
}

async function validateChatEventSourcesAreAppendOnly(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate append-only chat event sources ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const agentId = "00000000-0000-4000-8000-000000074401";
  let threadId: string | undefined;
  let messageId: string | undefined;

  try {
    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, 'append-only-test-org', 'append-only-test-user',
         'append-only-migration-test')`,
      [agentId],
    );

    const thread = await client.query<{ id: string }>(
      `
        INSERT INTO "chat_threads" (
          "user_id",
          "agent_id",
          "title"
        )
        VALUES ('append-only-test-user', $1, 'append-only migration test')
        RETURNING "id"
      `,
      [agentId],
    );
    threadId = thread.rows[0]?.id;
    if (!threadId) {
      throw new Error("Failed to create append-only chat thread fixture");
    }

    // Insert through the canonical table with application-reserved seq_ids.
    messageId = await validateCanonicalChatMessageStorage(client, threadId);
    await validateCanonicalDraftStorage(client, threadId);

    const event = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'created',
          $2,
          'append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentId],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) {
      throw new Error("Failed to create append-only chat thread event fixture");
    }
    assert.equal(event.rows[0]?.seqId, "1");
    const threadEventSequenceState = await client.query<{
      lastSeqId: string;
    }>(
      `
        SELECT "last_seq_id" AS "lastSeqId"
        FROM "chat_thread_event_sequences"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    assert.equal(threadEventSequenceState.rows[0]?.lastSeqId, "1");

    const nextEvent = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'renamed',
          $2,
          'advanced append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentId],
    );
    const nextEventId = nextEvent.rows[0]?.id;
    if (!nextEventId) {
      throw new Error("Failed to create second chat thread event fixture");
    }
    assert.equal(nextEvent.rows[0]?.seqId, "2");

    const snapshot = await client.query<{ latestSeqId: string }>(
      `
        INSERT INTO "chat_thread_snapshots" (
          "user_id",
          "org_id",
          "latest_event_id"
        )
        VALUES ('append-only-test-user', 'append-only-test-org', $1)
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [eventId],
    );
    assert.equal(snapshot.rows[0]?.latestSeqId, "1");

    const advancedSnapshot = await client.query<{ latestSeqId: string }>(
      `
        UPDATE "chat_thread_snapshots"
        SET "latest_event_id" = $1
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [nextEventId],
    );
    assert.equal(advancedSnapshot.rows[0]?.latestSeqId, "2");

    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_events",
      query: `UPDATE "chat_events" SET "event_type" = "event_type" WHERE "id" = $1`,
      rowId: messageId,
    });
    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_thread_events",
      query: `UPDATE "chat_thread_events" SET "title" = 'mutated' WHERE "id" = $1`,
      rowId: eventId,
    });

    console.log("   ✅ chat_events rejects UPDATE");
    console.log("   ✅ chat_thread_events rejects UPDATE\n");
    console.log("   ✅ chat event writes use application-reserved seq_ids\n");
  } finally {
    await client.query(
      `
        DELETE FROM "chat_thread_snapshots"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    await client.query(
      `
        DELETE FROM "chat_thread_events"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
    await client.end();
  }
}

async function validateChatEventContextPointerConstraints(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate chat event context pointer ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const agentId = "00000000-0000-4000-8000-000000074501";
  const threadId = "00000000-0000-4000-8000-000000074502";

  try {
    await client.query(
      `
        INSERT INTO "agents" ("id", "org_id", "owner", "name")
        VALUES ($1, 'context-pointer-test-org', 'context-pointer-test-user',
          'context-pointer-test')
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "chat_threads" (
          "id",
          "user_id",
          "agent_id",
          "last_chat_event_seq_id",
          "title"
        )
        VALUES (
          $1,
          'context-pointer-test-user',
          $2,
          2,
          'context pointer test'
        )
      `,
      [threadId, agentId],
    );

    const accepted = await client.query<{
      contextId: string | null;
      contextType: string | null;
    }>(
      `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "payload",
          "seq_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000074510',
            $1,
            'output.message',
            NULL,
            NULL,
            NULL,
            1
          ),
          (
            '00000000-0000-4000-8000-000000074511',
            $1,
            'output.message',
            'slack',
            '00000000-0000-4000-8000-000000074503',
            NULL,
            2
          ),
          (
            '00000000-0000-4000-8000-000000074512',
            $1,
            'input.prompt',
            'web',
            NULL,
            '{"userMessage":{"version":1,"parts":[{"type":"text","text":"web discriminator"}]}}'::jsonb,
            3
          ),
          (
            '00000000-0000-4000-8000-000000074515',
            $1,
            'input.rejected',
            NULL,
            NULL,
            '{"userMessage":{"version":1,"parts":[{"type":"text","text":"rejected input"}]}}'::jsonb,
            4
          )
        RETURNING
          "context_type" AS "contextType",
          "context_id" AS "contextId"
      `,
      [threadId],
    );
    assert.deepEqual(accepted.rows, [
      { contextId: null, contextType: null },
      {
        contextId: "00000000-0000-4000-8000-000000074503",
        contextType: "slack",
      },
      { contextId: null, contextType: "web" },
      { contextId: null, contextType: null },
    ]);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_pair_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074513',
          $1,
          'output.message',
          '00000000-0000-4000-8000-000000074504',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074514',
          $1,
          'output.message',
          'discord',
          '00000000-0000-4000-8000-000000074505',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_input_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "payload",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074516',
          $1,
          'input.prompt',
          NULL,
          NULL,
          '{"userMessage":{"version":1,"parts":[{"type":"text","text":"missing discriminator"}]}}'::jsonb,
          5
        )
      `,
      values: [threadId],
    });

    console.log(
      "   ✅ Chat event contexts require input discriminators while allowing context-less rejected inputs\n",
    );
  } finally {
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
    await client.end();
  }
}

async function runNormalizedComparison(
  dbUrl1: string,
  dbUrl2: string,
): Promise<boolean> {
  console.log(`📸 Running normalized schema comparison...`);
  try {
    execCommand(
      `tsx ${path.join(dirname, "compare-schemas-normalized.ts")} "${dbUrl1}" "${dbUrl2}"`,
      { cwd: PACKAGE_DIR },
    );
    return true;
  } catch {
    return false;
  }
}

async function backupMigrations(): Promise<void> {
  console.log("📦 Backing up current migrations...");
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  await fs.cp(MIGRATIONS_DIR, BACKUP_DIR, { recursive: true });
}

async function restoreMigrations(): Promise<void> {
  console.log("♻️  Restoring original migrations...");
  await fs.access(BACKUP_DIR);
  await fs.rm(RESTORE_DIR, { recursive: true, force: true });
  await fs.cp(BACKUP_DIR, RESTORE_DIR, { recursive: true });
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.rename(RESTORE_DIR, MIGRATIONS_DIR);
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
}

async function addPgVectorExtensionPreludeToGeneratedMigrations(): Promise<void> {
  const sqlFiles = (await fs.readdir(MIGRATIONS_DIR))
    .filter((file) => {
      return file.endsWith(".sql");
    })
    .sort();

  const sqlByFile = await Promise.all(
    sqlFiles.map(async (file) => {
      return {
        file,
        sql: await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8"),
      };
    }),
  );

  const usesPgVector = sqlByFile.some(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!usesPgVector) {
    return;
  }

  const hasPgVectorExtension = sqlByFile.some(({ sql }) => {
    return /CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?vector"?/i.test(sql);
  });
  if (hasPgVectorExtension) {
    return;
  }

  const firstPgVectorMigration = sqlByFile.find(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!firstPgVectorMigration) {
    return;
  }

  const migrationPath = path.join(MIGRATIONS_DIR, firstPgVectorMigration.file);
  await fs.writeFile(
    migrationPath,
    `CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint\n${firstPgVectorMigration.sql}`,
  );
  console.log(
    `   Added pgvector extension prelude to generated migration ${firstPgVectorMigration.file}`,
  );
}

async function generateFreshMigrations(): Promise<void> {
  console.log("🔨 Generating fresh migrations from schema...");

  // Delete existing migrations
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });

  // Generate new migrations (non-interactive)
  execCommand("pnpm drizzle-kit generate", { cwd: PACKAGE_DIR });
  await addPgVectorExtensionPreludeToGeneratedMigrations();
}

async function validateSnapshotFiles(): Promise<void> {
  console.log("=== Phase 0: Validate Snapshot Files ===\n");

  // Count SQL files
  const files = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = files
    .filter((f) => {
      return f.endsWith(".sql");
    })
    .sort();

  // Count snapshot files
  const metaFiles = await fs.readdir(path.join(MIGRATIONS_DIR, "meta"));
  const snapshotFiles = metaFiles
    .filter((f) => {
      return f.endsWith("_snapshot.json");
    })
    .sort();

  console.log(`   SQL migrations: ${sqlFiles.length}`);
  console.log(`   Snapshot files: ${snapshotFiles.length}`);

  // Check if counts match
  if (sqlFiles.length !== snapshotFiles.length) {
    console.error(
      `   ❌ Mismatch: ${sqlFiles.length} SQL files but ${snapshotFiles.length} snapshots`,
    );
    throw new Error("Migration count mismatch");
  }

  // Check each migration has a snapshot
  const missingSnapshots: string[] = [];
  for (const sqlFile of sqlFiles) {
    const match = sqlFile.match(/^(\d{4})_/);
    if (!match) continue;

    const idx = match[1];
    const snapshotFile = `${idx}_snapshot.json`;

    if (!snapshotFiles.includes(snapshotFile)) {
      missingSnapshots.push(sqlFile);
    }
  }

  if (missingSnapshots.length > 0) {
    console.error(
      `   ❌ Missing snapshots for migrations: ${missingSnapshots.join(", ")}`,
    );
    throw new Error("Missing snapshot files");
  }

  // Validate snapshot chain integrity
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  let prevId: string | undefined;
  let chainBroken = false;
  for (const [position, entry] of entries.entries()) {
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));

    if (position > 0 && snapshot.prevId !== prevId) {
      console.error(`   ❌ Snapshot ${entry.idx} prevId mismatch:`);
      console.error(`      Expected: ${prevId}`);
      console.error(`      Got: ${snapshot.prevId}`);
      chainBroken = true;
      break;
    }

    prevId = snapshot.id;
  }

  if (chainBroken) {
    console.error(`\n❌ SNAPSHOT CHAIN BROKEN`);
    console.error(
      `\n   This means the snapshot system is corrupted and needs to be rebuilt.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(`      1. Reset database: pnpm -F @okouai/db db:reset`);
    console.error(`      2. Delete your manual migration file (if any)`);
    console.error(`      3. Remove migration entry from meta/_journal.json`);
    console.error(
      `      4. Generate migration: pnpm -F @okouai/db db:generate`,
    );
    console.error(`      5. Apply migration: pnpm -F @okouai/db db:migrate`);
    console.error(`\n   ⚠️  IMPORTANT: Never manually write migration files!`);
    console.error(
      `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
    );
    console.error(`      Manual migrations break the snapshot chain.\n`);
    throw new Error("Snapshot chain broken");
  }

  console.log(`   ✅ All ${sqlFiles.length} migrations have snapshots`);
  console.log(`   ✅ Snapshot chain validated (id/prevId references intact)`);
  console.log();
}

async function validateMigrationTagReferences(): Promise<void> {
  console.log("=== Phase 0.1: Validate Migration Tag References ===\n");

  const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:applyMigrationsUpTo|runMigrationsUpTo)\s*\(/u,
    "Transition validators must reference migrations by tag, not numeric index",
  );

  console.log("   ✅ Transition validators reference migrations by tag\n");
}

async function expectDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly messageIncludes?: string;
    readonly query: string;
    readonly values?: readonly (string | number | null)[];
  },
): Promise<void> {
  try {
    await client.query(args.query, args.values ? [...args.values] : undefined);
  } catch (error) {
    assert.equal(databaseErrorCode(error), args.code);
    if (args.messageIncludes !== undefined) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(args.messageIncludes));
    }
    return;
  }
  throw new Error(`Expected database error ${args.code}`);
}

const INTEGRATION_USER_ID_CONTRACT_PREVIOUS_MIGRATION =
  "0940_reconcile_feishu_custom_connector_ownership";
const INTEGRATION_USER_ID_CONTRACT_MIGRATION =
  "0943_contract_legacy_integration_identity";
const RETIRED_INTEGRATION_ID_COLUMN = ["vm0", "user", "id"].join("_");

const INTEGRATION_USER_ID_TABLES = [
  "agentphone_user_agent_preferences",
  "agentphone_user_links",
  "feishu_org_connections",
  "feishu_user_agent_preferences",
  "github_user_links",
  "slack_org_connections",
  "slack_user_agent_preferences",
  "teams_org_connections",
  "teams_user_agent_preferences",
  "telegram_official_user_links",
  "telegram_user_agent_preferences",
  "telegram_user_links",
] as const;

const INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS = [
  {
    constraintName: "agentphone_user_agent_preferences_user_id_org_id_pk",
    tableName: "agentphone_user_agent_preferences",
  },
  {
    constraintName: "feishu_user_agent_preferences_user_id_org_id_pk",
    tableName: "feishu_user_agent_preferences",
  },
  {
    constraintName: "slack_user_agent_preferences_user_id_org_id_pk",
    tableName: "slack_user_agent_preferences",
  },
  {
    constraintName: "teams_user_agent_preferences_user_id_org_id_pk",
    tableName: "teams_user_agent_preferences",
  },
  {
    constraintName: "telegram_user_agent_preferences_user_id_org_id_pk",
    tableName: "telegram_user_agent_preferences",
  },
] as const;

const INTEGRATION_USER_ID_CANONICAL_INDEXES = [
  {
    definition:
      "CREATE UNIQUE INDEX agentphone_user_agent_preferences_user_id_org_id_pk ON public.agentphone_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "agentphone_user_agent_preferences_user_id_org_id_pk",
    tableName: "agentphone_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_agentphone_user_links_user_org ON public.agentphone_user_links USING btree (user_id, org_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_agentphone_user_links_user_org",
    tableName: "agentphone_user_links",
  },
  {
    definition:
      "CREATE INDEX idx_feishu_org_connections_user_id_installation ON public.feishu_org_connections USING btree (user_id, installation_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_feishu_org_connections_user_id_installation",
    tableName: "feishu_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX feishu_user_agent_preferences_user_id_org_id_pk ON public.feishu_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "feishu_user_agent_preferences_user_id_org_id_pk",
    tableName: "feishu_user_agent_preferences",
  },
  {
    definition:
      "CREATE INDEX idx_slack_org_connections_user_id_workspace ON public.slack_org_connections USING btree (user_id, slack_workspace_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_slack_org_connections_user_id_workspace",
    tableName: "slack_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX slack_user_agent_preferences_user_id_org_id_pk ON public.slack_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "slack_user_agent_preferences_user_id_org_id_pk",
    tableName: "slack_user_agent_preferences",
  },
  {
    definition:
      "CREATE INDEX idx_teams_org_connections_user_id_tenant ON public.teams_org_connections USING btree (user_id, teams_tenant_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_teams_org_connections_user_id_tenant",
    tableName: "teams_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX teams_user_agent_preferences_user_id_org_id_pk ON public.teams_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "teams_user_agent_preferences_user_id_org_id_pk",
    tableName: "teams_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_telegram_official_user_links_user_org ON public.telegram_official_user_links USING btree (user_id, org_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_telegram_official_user_links_user_org",
    tableName: "telegram_official_user_links",
  },
  {
    definition:
      "CREATE UNIQUE INDEX telegram_user_agent_preferences_user_id_org_id_pk ON public.telegram_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "telegram_user_agent_preferences_user_id_org_id_pk",
    tableName: "telegram_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_telegram_user_links_user_id_installation ON public.telegram_user_links USING btree (user_id, installation_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_telegram_user_links_user_id_installation",
    tableName: "telegram_user_links",
  },
] as const;

async function assertCanonicalIntegrationIdentitySchema(
  client: Client,
): Promise<void> {
  const tableNames = [...INTEGRATION_USER_ID_TABLES];
  const columns = await client.query<{
    columnName: string;
    isNullable: "NO" | "YES";
    tableName: string;
  }>(
    [
      'SELECT "table_name" AS "tableName",',
      '  "column_name" AS "columnName",',
      '  "is_nullable" AS "isNullable"',
      'FROM "information_schema"."columns"',
      "WHERE \"table_schema\" = 'public'",
      '  AND "table_name" = ANY($1::text[])',
      '  AND "column_name" = ANY($2::text[])',
      'ORDER BY "table_name", "column_name"',
    ].join("\n"),
    [tableNames, ["user_id", RETIRED_INTEGRATION_ID_COLUMN]],
  );
  assert.deepEqual(
    columns.rows,
    INTEGRATION_USER_ID_TABLES.map((tableName) => {
      return { columnName: "user_id", isNullable: "NO", tableName };
    }),
  );

  const primaryKeys = await client.query<{
    constraintName: string;
    definition: string;
    tableName: string;
  }>(
    [
      'SELECT "relation"."relname" AS "tableName",',
      '  "constraint"."conname" AS "constraintName",',
      '  pg_get_constraintdef("constraint"."oid", false) AS "definition"',
      'FROM "pg_constraint" AS "constraint"',
      'INNER JOIN "pg_class" AS "relation"',
      '  ON "relation"."oid" = "constraint"."conrelid"',
      'INNER JOIN "pg_namespace" AS "namespace"',
      '  ON "namespace"."oid" = "relation"."relnamespace"',
      'WHERE "namespace"."nspname" = \'public\'',
      '  AND "constraint"."contype" = \'p\'',
      '  AND "relation"."relname" = ANY($1::text[])',
      'ORDER BY "relation"."relname"',
    ].join("\n"),
    [
      INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS.map(({ tableName }) => {
        return tableName;
      }),
    ],
  );
  assert.deepEqual(
    primaryKeys.rows,
    INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS.map(
      ({ constraintName, tableName }) => {
        return {
          constraintName,
          definition: "PRIMARY KEY (user_id, org_id)",
          tableName,
        };
      },
    ),
  );

  await client.query("SET search_path TO public, pg_catalog");
  const indexes = await client.query<{
    definition: string;
    isPrimary: boolean;
    isUnique: boolean;
    name: string;
    tableName: string;
  }>(
    [
      'SELECT "table"."relname" AS "tableName",',
      '  "index_class"."relname" AS "name",',
      '  "index"."indisprimary" AS "isPrimary",',
      '  "index"."indisunique" AS "isUnique",',
      '  pg_get_indexdef("index"."indexrelid") AS "definition"',
      'FROM "pg_index" AS "index"',
      'INNER JOIN "pg_class" AS "index_class"',
      '  ON "index_class"."oid" = "index"."indexrelid"',
      'INNER JOIN "pg_class" AS "table"',
      '  ON "table"."oid" = "index"."indrelid"',
      'WHERE "index_class"."relname" = ANY($1::text[])',
      'ORDER BY "table"."relname"',
    ].join("\n"),
    [
      INTEGRATION_USER_ID_CANONICAL_INDEXES.map(({ name }) => {
        return name;
      }),
    ],
  );
  assert.deepEqual(indexes.rows, INTEGRATION_USER_ID_CANONICAL_INDEXES);
}

async function validateIntegrationUserIdContractMigration(): Promise<void> {
  console.log("=== Validate canonical integration identity Contract ===\n");
  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, INTEGRATION_USER_ID_CONTRACT_MIGRATION + ".sql"),
    "utf8",
  );
  assert.ok(!migrationSql.includes(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bCASCADE\b/iu);

  const validationOffset = migrationSql.indexOf(
    "integration identity Contract validation failed",
  );
  assert.ok(validationOffset >= 0);
  const firstDestructiveOffset = Math.min(
    ...[
      "DROP CONSTRAINT",
      "DROP INDEX",
      "DROP TRIGGER",
      "DROP COLUMN",
      "DROP FUNCTION",
    ]
      .map((statement) => {
        return migrationSql.indexOf(statement);
      })
      .filter((offset) => {
        return offset >= 0;
      }),
  );
  assert.ok(validationOffset < firstDestructiveOffset);

  for (const tableName of INTEGRATION_USER_ID_TABLES) {
    const backfill =
      'UPDATE "' +
      tableName +
      '" SET "user_id" = "' +
      RETIRED_INTEGRATION_ID_COLUMN +
      '" WHERE "user_id" IS NULL';
    const dropColumn =
      'ALTER TABLE "' +
      tableName +
      '" DROP COLUMN "' +
      RETIRED_INTEGRATION_ID_COLUMN +
      '"';
    const dropTrigger =
      'DROP TRIGGER "sync_' +
      tableName +
      '_identity_0930" ON "' +
      tableName +
      '"';
    const validation =
      'FROM "' +
      tableName +
      '" WHERE "user_id" IS NULL OR "' +
      RETIRED_INTEGRATION_ID_COLUMN +
      '" IS NULL OR "user_id" IS DISTINCT FROM "' +
      RETIRED_INTEGRATION_ID_COLUMN +
      '"';
    const backfillOffset = migrationSql.indexOf(backfill);
    const validationPredicateOffset = migrationSql.indexOf(validation);
    const dropTriggerOffset = migrationSql.indexOf(dropTrigger);
    const dropColumnOffset = migrationSql.indexOf(dropColumn);
    assert.ok(backfillOffset >= 0);
    assert.ok(backfillOffset < validationOffset);
    assert.ok(validationPredicateOffset >= 0);
    assert.ok(validationPredicateOffset < validationOffset);
    assert.ok(dropTriggerOffset > validationOffset);
    assert.ok(dropColumnOffset > dropTriggerOffset);
  }
  assert.equal((migrationSql.match(/\bDROP\s+CONSTRAINT\b/gu) ?? []).length, 5);
  assert.equal((migrationSql.match(/\bDROP\s+INDEX\b/gu) ?? []).length, 6);
  assert.equal((migrationSql.match(/\bDROP\s+TRIGGER\b/gu) ?? []).length, 12);
  assert.equal((migrationSql.match(/\bDROP\s+COLUMN\b/gu) ?? []).length, 12);
  assert.equal((migrationSql.match(/\bDROP\s+FUNCTION\b/gu) ?? []).length, 1);
  assert.equal(
    (migrationSql.match(/\bPRIMARY\s+KEY\s+USING\s+INDEX\b/gu) ?? []).length,
    5,
  );

  const testDb = "migration_integration_user_identity_contract_test";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const fixture = {
    orgId: "contract-integration-identity-org",
    tableName: "agentphone_user_agent_preferences",
    triggerName: "sync_agentphone_user_agent_preferences_identity_0930",
    userId: "contract-integration-identity-user",
  } as const;

  try {
    await applyMigrationsUpToTag(
      client,
      INTEGRATION_USER_ID_CONTRACT_PREVIOUS_MIGRATION,
    );
    await client.query(
      'INSERT INTO "' +
        fixture.tableName +
        '" ("user_id", "org_id") VALUES ($1, $2)',
      [fixture.userId, fixture.orgId],
    );
    await client.query(
      'ALTER TABLE "' +
        fixture.tableName +
        '" DISABLE TRIGGER "' +
        fixture.triggerName +
        '"',
    );
    await client.query(
      'UPDATE "' +
        fixture.tableName +
        '" SET "user_id" = $1 WHERE "org_id" = $2',
      ["contract-conflicting-user", fixture.orgId],
    );
    await client.query(
      'ALTER TABLE "' +
        fixture.tableName +
        '" ENABLE TRIGGER "' +
        fixture.triggerName +
        '"',
    );

    await assert.rejects(
      applyMigrationsUpToTag(client, INTEGRATION_USER_ID_CONTRACT_MIGRATION),
      (error: unknown) => {
        return (
          databaseErrorCode(error) === "23514" &&
          error instanceof Error &&
          error.message.includes("Contract validation failed")
        );
      },
    );
    const retainedColumn = await client.query<{ count: number }>(
      [
        'SELECT count(*)::integer AS "count"',
        'FROM "information_schema"."columns"',
        "WHERE \"table_schema\" = 'public'",
        '  AND "table_name" = $1',
        '  AND "column_name" = $2',
      ].join("\n"),
      [fixture.tableName, RETIRED_INTEGRATION_ID_COLUMN],
    );
    assert.deepEqual(retainedColumn.rows, [{ count: 1 }]);

    await client.query(
      'ALTER TABLE "' +
        fixture.tableName +
        '" DISABLE TRIGGER "' +
        fixture.triggerName +
        '"',
    );
    await client.query(
      'UPDATE "' +
        fixture.tableName +
        '" SET "user_id" = "' +
        RETIRED_INTEGRATION_ID_COLUMN +
        '" WHERE "org_id" = $1',
      [fixture.orgId],
    );
    await client.query(
      'ALTER TABLE "' +
        fixture.tableName +
        '" ENABLE TRIGGER "' +
        fixture.triggerName +
        '"',
    );

    await applyMigrationsUpToTag(
      client,
      INTEGRATION_USER_ID_CONTRACT_MIGRATION,
    );
    await assertCanonicalIntegrationIdentitySchema(client);
    const retainedRow = await client.query<{
      orgId: string;
      userId: string;
    }>(
      'SELECT "user_id" AS "userId", "org_id" AS "orgId" FROM "' +
        fixture.tableName +
        '" WHERE "org_id" = $1',
      [fixture.orgId],
    );
    assert.deepEqual(retainedRow.rows, [
      { orgId: fixture.orgId, userId: fixture.userId },
    ]);

    console.log("   ✅ Contract validation aborts before destructive DDL");
    console.log("   ✅ canonical data survives the identity contraction");
    console.log(
      "   ✅ 12 columns, 5 primary keys, and 11 indexes are canonical\n",
    );
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

async function validateCanonicalIntegrationIdentitySchema(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.2: Validate canonical integration identity schema ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await assertCanonicalIntegrationIdentitySchema(client);
    console.log(
      "   ✅ Canonical integration identity columns, keys, and indexes match\n",
    );
  } finally {
    await client.end();
  }
}
const MCP_CUSTOM_CONNECTOR_READERS_PREVIOUS_MIGRATION =
  "0872_curious_yellow_claw";
const MCP_CUSTOM_CONNECTOR_READERS_MIGRATION =
  "0873_prepare_mcp_custom_connector_readers";
const CUSTOM_CONNECTOR_DEFINITION_CONTRACTION_PREVIOUS_MIGRATION =
  "0897_bizarre_kid_colt";
const CUSTOM_CONNECTOR_DEFINITION_CONTRACTION_MIGRATION =
  "0902_colorful_mandrill";

const CONNECTION_SCOPED_VARIABLE_PREVIOUS_MIGRATION =
  "0900_replace_scheduled_usage_pack_change";
const CONNECTION_SCOPED_VARIABLE_MIGRATION = "0901_parallel_energizer";
const CONNECTION_SCOPED_VARIABLE_SHADOW_INDEX =
  "idx_variables_org_user_type_name_0901";

async function assertConnectionScopedVariableIndexes(
  client: Client,
): Promise<void> {
  const indexes = await client.query<{
    definition: string;
    isUnique: boolean;
    isValid: boolean;
    name: string;
    predicate: string | null;
  }>(`
    SELECT
      "index_class"."relname" AS "name",
      "index"."indisunique" AS "isUnique",
      "index"."indisvalid" AS "isValid",
      pg_get_indexdef("index"."indexrelid") AS "definition",
      pg_get_expr("index"."indpred", "index"."indrelid") AS "predicate"
    FROM "pg_index" AS "index"
    INNER JOIN "pg_class" AS "index_class"
      ON "index_class"."oid" = "index"."indexrelid"
    INNER JOIN "pg_class" AS "table_class"
      ON "table_class"."oid" = "index"."indrelid"
    WHERE "table_class"."relname" = 'variables'
      AND "index_class"."relname" IN (
        'idx_variables_org_user_type_name',
        'idx_variables_connector_name',
        '${CONNECTION_SCOPED_VARIABLE_SHADOW_INDEX}'
      )
    ORDER BY "index_class"."relname"
  `);
  assert.deepEqual(
    indexes.rows.map((index) => {
      return {
        isUnique: index.isUnique,
        isValid: index.isValid,
        name: index.name,
      };
    }),
    [
      {
        isUnique: true,
        isValid: true,
        name: "idx_variables_connector_name",
      },
      {
        isUnique: true,
        isValid: true,
        name: "idx_variables_org_user_type_name",
      },
    ],
  );
  const connectorIndex = indexes.rows[0];
  const userIndex = indexes.rows[1];
  assert.match(
    connectorIndex?.definition ?? "",
    /\(connector_id, name\).*WHERE \(connector_id IS NOT NULL\)$/u,
  );
  assert.match(connectorIndex?.predicate ?? "", /connector_id IS NOT NULL/u);
  assert.match(
    userIndex?.definition ?? "",
    /\(org_id, user_id, type, name\).*WHERE \(connector_id IS NULL\)$/u,
  );
  assert.match(userIndex?.predicate ?? "", /connector_id IS NULL/u);

  const ownerConstraint = await client.query<{
    definition: string;
    isValidated: boolean;
  }>(`
    SELECT
      pg_get_constraintdef("constraint"."oid") AS "definition",
      "constraint"."convalidated" AS "isValidated"
    FROM "pg_constraint" AS "constraint"
    WHERE "constraint"."conrelid" = 'public.variables'::regclass
      AND "constraint"."conname" = 'fk_variables_connector_owner'
  `);
  assert.equal(ownerConstraint.rows.length, 1);
  assert.equal(ownerConstraint.rows[0]?.isValidated, true);
  assert.match(
    ownerConstraint.rows[0]?.definition ?? "",
    /FOREIGN KEY \(connector_id, org_id, user_id\) REFERENCES connectors\(id, org_id, user_id\) ON DELETE CASCADE/u,
  );
}

function connectionScopedVariableMigrationStatements(
  migrationSql: string,
): readonly [string, string, string] {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  assert.equal(statements.length, 3);
  const dropShadowIndex = statements.at(0);
  const createShadowIndex = statements.at(1);
  const swapIndexes = statements.at(2);
  assert.ok(dropShadowIndex);
  assert.ok(createShadowIndex);
  assert.ok(swapIndexes);
  return [dropShadowIndex, createShadowIndex, swapIndexes];
}

async function rerunConnectionScopedVariableMigration(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

async function validateConnectionScopedVariableUniqueness(): Promise<void> {
  console.log(
    "=== Validate connection-scoped variable uniqueness contraction ===\n",
  );
  const testDb = "migration_connection_scoped_variable_uniqueness_test";
  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, `${CONNECTION_SCOPED_VARIABLE_MIGRATION}.sql`),
    "utf8",
  );
  const migrationStatements =
    connectionScopedVariableMigrationStatements(migrationSql);
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.match(
    migrationSql,
    new RegExp(
      `CREATE UNIQUE INDEX CONCURRENTLY "${CONNECTION_SCOPED_VARIABLE_SHADOW_INDEX}"`,
      "u",
    ),
  );
  assert.match(
    migrationSql,
    /DROP INDEX "idx_variables_org_user_type_name"[\s\S]*ALTER INDEX "idx_variables_org_user_type_name_0901"[\s\S]*RENAME TO "idx_variables_org_user_type_name"/u,
  );

  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const orgId = "migration-variable-org";
  const userId = "migration-variable-user";
  const firstConnectorId = "26233000-0000-4000-8000-000000000001";
  const secondConnectorId = "26233000-0000-4000-8000-000000000002";
  const connectorVariableName = "SHARED_CONNECTOR_VARIABLE";
  const userVariableName = "USER_VARIABLE";

  try {
    await applyMigrationsUpToTag(
      client,
      CONNECTION_SCOPED_VARIABLE_PREVIOUS_MIGRATION,
    );
    await client.query(
      `
        INSERT INTO "connectors" (
          "id",
          "connector_slug",
          "auth_method",
          "storage_version",
          "org_id",
          "user_id"
        )
        VALUES
          ($1, 'migration-variable-first', 'manual', 1, $3, $4),
          ($2, 'migration-variable-second', 'manual', 1, $3, $4)
      `,
      [firstConnectorId, secondConnectorId, orgId, userId],
    );
    await client.query(
      `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', $4, 'first')
      `,
      [firstConnectorId, orgId, userId, connectorVariableName],
    );
    await client.query(
      `
        INSERT INTO "variables" (
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, 'user', $3, 'user-first')
      `,
      [orgId, userId, userVariableName],
    );
    await expectDatabaseError(client, {
      code: "23505",
      messageIncludes: "idx_variables_org_user_type_name",
      query: `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', $4, 'blocked-before-migration')
      `,
      values: [secondConnectorId, orgId, userId, connectorVariableName],
    });

    await client.query(migrationStatements[0]);
    await client.query(migrationStatements[1]);
    const interruptedIndexes = await client.query<{
      isValid: boolean;
      name: string;
      predicate: string | null;
    }>(`
      SELECT
        "index_class"."relname" AS "name",
        "index"."indisvalid" AS "isValid",
        pg_get_expr("index"."indpred", "index"."indrelid") AS "predicate"
      FROM "pg_index" AS "index"
      INNER JOIN "pg_class" AS "index_class"
        ON "index_class"."oid" = "index"."indexrelid"
      INNER JOIN "pg_class" AS "table_class"
        ON "table_class"."oid" = "index"."indrelid"
      WHERE "table_class"."relname" = 'variables'
        AND "index_class"."relname" IN (
          'idx_variables_org_user_type_name',
          '${CONNECTION_SCOPED_VARIABLE_SHADOW_INDEX}'
        )
      ORDER BY "index_class"."relname"
    `);
    assert.deepEqual(interruptedIndexes.rows, [
      {
        isValid: true,
        name: "idx_variables_org_user_type_name",
        predicate: null,
      },
      {
        isValid: true,
        name: CONNECTION_SCOPED_VARIABLE_SHADOW_INDEX,
        predicate: "(connector_id IS NULL)",
      },
    ]);
    await rerunConnectionScopedVariableMigration(client, migrationStatements);
    await client.query(
      `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', $4, 'second')
      `,
      [secondConnectorId, orgId, userId, connectorVariableName],
    );
    await expectDatabaseError(client, {
      code: "23505",
      messageIncludes: "idx_variables_connector_name",
      query: `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', $4, 'duplicate-first')
      `,
      values: [firstConnectorId, orgId, userId, connectorVariableName],
    });
    await expectDatabaseError(client, {
      code: "23505",
      messageIncludes: "idx_variables_org_user_type_name",
      query: `
        INSERT INTO "variables" (
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, 'user', $3, 'user-duplicate')
      `,
      values: [orgId, userId, userVariableName],
    });
    await client.query(
      `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', $4, 'first-updated')
        ON CONFLICT ("connector_id", "name")
          WHERE "connector_id" IS NOT NULL
        DO UPDATE SET "value" = EXCLUDED."value"
      `,
      [firstConnectorId, orgId, userId, connectorVariableName],
    );
    await expectDatabaseError(client, {
      code: "42P10",
      query: `
        INSERT INTO "variables" (
          "connector_id",
          "org_id",
          "user_id",
          "type",
          "name",
          "value"
        )
        VALUES ($1, $2, $3, 'connector', 'LEGACY_TARGET', 'legacy')
        ON CONFLICT ("org_id", "user_id", "type", "name")
        DO UPDATE SET "value" = EXCLUDED."value"
      `,
      values: [firstConnectorId, orgId, userId],
    });

    const connectorVariables = await client.query<{
      connectorId: string;
      value: string;
    }>(
      `
        SELECT "connector_id" AS "connectorId", "value"
        FROM "variables"
        WHERE "org_id" = $1
          AND "user_id" = $2
          AND "type" = 'connector'
          AND "name" = $3
        ORDER BY "connector_id"
      `,
      [orgId, userId, connectorVariableName],
    );
    assert.deepEqual(connectorVariables.rows, [
      { connectorId: firstConnectorId, value: "first-updated" },
      { connectorId: secondConnectorId, value: "second" },
    ]);
    await assertConnectionScopedVariableIndexes(client);

    await rerunConnectionScopedVariableMigration(client, migrationStatements);
    await assertConnectionScopedVariableIndexes(client);

    console.log("   ✅ old global uniqueness rejects cross-connection names");
    console.log("   ✅ final indexes split user and connection uniqueness");
    console.log("   ✅ current upserts retain exact connection ownership");
    console.log("   ✅ old connector conflict inference is removed");
    console.log(
      "   ✅ concurrent shadow interruption and full rerun recover cleanly\n",
    );
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

async function validateMcpCustomConnectorReaderPreparation(): Promise<void> {
  console.log("=== Validate MCP Custom Connector reader preparation ===\n");
  const testDb = "migration_mcp_custom_connector_readers_test";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const connectorId = "26007000-0000-4000-8000-000000000001";
  const agentId = "26007000-0000-4000-8000-000000000002";
  const mcpConnectorId = "26007000-0000-4000-8000-000000000003";

  try {
    await applyMigrationsUpToTag(
      client,
      MCP_CUSTOM_CONNECTOR_READERS_PREVIOUS_MIGRATION,
    );

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefixes",
          "header_name",
          "header_template",
          "prefix_templates",
          "mcp_resource",
          "created_by"
        ) VALUES (
          $1,
          'issue-26007-org',
          '_existing-http',
          'Existing HTTP',
          '["https://api.example.test/"]'::jsonb,
          'Authorization',
          'Bearer {{secret}}',
          '["https://api.example.test/"]'::jsonb,
          'legacy-resource',
          'issue-26007-user'
        )
      `,
      [connectorId],
    );
    await client.query(
      `
        INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
        VALUES ($1, 'issue-26007-user', 'issue-26007-agent', 'issue-26007-org')
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "zero_agents" (
          "id", "org_id", "owner", "name", "visibility"
        ) VALUES (
          $1,
          'issue-26007-org',
          'issue-26007-user',
          'issue-26007-agent',
          'private'
        )
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "user_custom_connectors" (
          "org_id",
          "user_id",
          "agent_id",
          "custom_connector_id",
          "allow_all_mcp_tools"
        ) VALUES (
          'issue-26007-org',
          'issue-26007-user',
          $1,
          $2,
          true
        )
      `,
      [agentId, connectorId],
    );

    await assert.rejects(
      applyMigrationsUpToTag(client, MCP_CUSTOM_CONNECTOR_READERS_MIGRATION),
      /Unexpected Custom Connector definition state/u,
    );
    await client.query(
      `UPDATE "org_custom_connectors" SET "mcp_resource" = NULL WHERE "id" = $1`,
      [connectorId],
    );
    await assert.rejects(
      applyMigrationsUpToTag(client, MCP_CUSTOM_CONNECTOR_READERS_MIGRATION),
      /Unexpected Custom Connector MCP tool-grant state/u,
    );
    await client.query(
      `UPDATE "user_custom_connectors" SET "allow_all_mcp_tools" = false`,
    );

    await applyMigrationsUpToTag(
      client,
      MCP_CUSTOM_CONNECTOR_READERS_MIGRATION,
    );

    const existingHttp = await client.query<{
      headerName: string | null;
      mcpEndpoint: string | null;
      mcpTransport: string | null;
      prefixes: string[];
    }>(
      `
        SELECT
          "header_name" AS "headerName",
          "mcp_endpoint" AS "mcpEndpoint",
          "mcp_transport" AS "mcpTransport",
          "prefixes"
        FROM "org_custom_connectors"
        WHERE "id" = $1
      `,
      [connectorId],
    );
    assert.deepEqual(existingHttp.rows, [
      {
        headerName: "Authorization",
        mcpEndpoint: null,
        mcpTransport: null,
        prefixes: ["https://api.example.test/"],
      },
    ]);

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefixes",
          "header_name",
          "header_template",
          "prefix_templates",
          "mcp_endpoint",
          "mcp_transport",
          "created_by"
        ) VALUES (
          $1,
          'issue-26007-org',
          '_mcp-reader',
          'MCP Reader',
          '[]'::jsonb,
          NULL,
          NULL,
          '[]'::jsonb,
          'https://mcp.example.test/server',
          'streamable-http',
          'issue-26007-user'
        )
      `,
      [mcpConnectorId],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "mcp_endpoint",
          "mcp_transport", "created_by"
        ) VALUES (
          'issue-26007-org', '_partial-mcp', 'Partial MCP', '[]'::jsonb,
          NULL, NULL, '[]'::jsonb, 'https://mcp.example.test/partial',
          NULL, 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "mcp_endpoint",
          "mcp_transport", "created_by"
        ) VALUES (
          'issue-26007-org', '_hybrid-mcp', 'Hybrid MCP',
          '["https://api.example.test/"]'::jsonb, NULL, NULL,
          '[]'::jsonb, 'https://mcp.example.test/hybrid',
          'streamable-http', 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "created_by"
        ) VALUES (
          'issue-26007-org', '_headerless-http', 'Headerless HTTP',
          '["https://api.example.test/"]'::jsonb, NULL, NULL,
          '["https://api.example.test/"]'::jsonb, 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        UPDATE "org_custom_connectors"
        SET "mcp_resource" = 'legacy-resource'
        WHERE "id" = $1
      `,
      values: [connectorId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_user_custom_connectors_mcp_grant",
      query: `
        UPDATE "user_custom_connectors"
        SET "allow_all_mcp_tools" = true
        WHERE "custom_connector_id" = $1
      `,
      values: [connectorId],
    });

    console.log("   ✅ legacy MCP state aborts instead of being cleared");
    console.log("   ✅ existing HTTP definitions remain valid");
    console.log("   ✅ only exhaustive MCP definition rows are accepted\n");
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

async function validateCustomConnectorDefinitionContraction(): Promise<void> {
  console.log("=== Validate Custom Connector definition contraction ===\n");
  const testDb = "migration_custom_connector_definition_contraction_test";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const httpConnectorId = "26216000-0000-4000-8000-000000000001";
  const mcpConnectorId = "26216000-0000-4000-8000-000000000002";

  try {
    await applyMigrationsUpToTag(
      client,
      CUSTOM_CONNECTOR_DEFINITION_CONTRACTION_PREVIOUS_MIGRATION,
    );

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "created_by"
        ) VALUES (
          $1,
          'issue-26216-org',
          '_canonical-http',
          'Canonical HTTP',
          '["https://api.example.test/"]'::jsonb,
          '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
          '[]'::jsonb,
          'issue-26216-user'
        )
      `,
      [httpConnectorId],
    );
    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "mcp_endpoint",
          "mcp_transport",
          "created_by"
        ) VALUES (
          $1,
          'issue-26216-org',
          '_canonical-mcp',
          'Canonical MCP',
          '[]'::jsonb,
          '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
          '[]'::jsonb,
          'https://mcp.example.test/server',
          'streamable-http',
          'issue-26216-user'
        )
      `,
      [mcpConnectorId],
    );

    const outgoingWriterRows = await client.query<{
      headerName: string | null;
      headerTemplate: string | null;
      prefixes: string[];
    }>(
      `
        SELECT
          "prefixes",
          "header_name" AS "headerName",
          "header_template" AS "headerTemplate"
        FROM "org_custom_connectors"
        WHERE "id" IN ($1, $2)
        ORDER BY "id"
      `,
      [httpConnectorId, mcpConnectorId],
    );
    assert.deepEqual(outgoingWriterRows.rows, [
      { prefixes: [], headerName: null, headerTemplate: null },
      { prefixes: [], headerName: null, headerTemplate: null },
    ]);

    await client.query(`
      CREATE VIEW "custom_connector_legacy_definition_dependency" AS
      SELECT "id", "header_template"
      FROM "org_custom_connectors"
    `);
    await assert.rejects(
      applyMigrationsUpToTag(
        client,
        CUSTOM_CONNECTOR_DEFINITION_CONTRACTION_MIGRATION,
      ),
      /cannot drop column header_template .* because other objects depend on it/u,
    );
    const columnsAfterRejectedContraction = await client.query<{
      columnName: string;
    }>(`
      SELECT "column_name" AS "columnName"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'org_custom_connectors'
        AND "column_name" IN ('prefixes', 'header_name', 'header_template')
      ORDER BY "column_name"
    `);
    assert.deepEqual(
      columnsAfterRejectedContraction.rows.map((row) => {
        return row.columnName;
      }),
      ["header_name", "header_template", "prefixes"],
    );

    await client.query(
      `DROP VIEW "custom_connector_legacy_definition_dependency"`,
    );
    await applyMigrationsUpToTag(
      client,
      CUSTOM_CONNECTOR_DEFINITION_CONTRACTION_MIGRATION,
    );

    const remainingLegacyColumns = await client.query<{ count: string }>(`
      SELECT count(*)::text AS "count"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'org_custom_connectors'
        AND "column_name" IN ('prefixes', 'header_name', 'header_template')
    `);
    assert.equal(remainingLegacyColumns.rows[0]?.count, "0");

    const canonicalRows = await client.query<{
      id: string;
      mcpEndpoint: string | null;
      prefixTemplates: string[];
    }>(
      `
        SELECT
          "id",
          "prefix_templates" AS "prefixTemplates",
          "mcp_endpoint" AS "mcpEndpoint"
        FROM "org_custom_connectors"
        WHERE "id" IN ($1, $2)
        ORDER BY "id"
      `,
      [httpConnectorId, mcpConnectorId],
    );
    assert.deepEqual(canonicalRows.rows, [
      {
        id: httpConnectorId,
        prefixTemplates: ["https://api.example.test/"],
        mcpEndpoint: null,
      },
      {
        id: mcpConnectorId,
        prefixTemplates: [],
        mcpEndpoint: "https://mcp.example.test/server",
      },
    ]);

    console.log("   ✅ outgoing canonical-only writes survive contraction");
    console.log(
      "   ✅ unexpected dependencies abort the contraction atomically",
    );
    console.log(
      "   ✅ retired columns are absent after the dependency is removed\n",
    );
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

type PermanentTrigger = {
  readonly definition: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly triggerName: string;
};

type PermanentFunction = {
  readonly bodyHash: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly kind: string;
  readonly schemaName: string;
};

// Exported from a database built by the existing migration chain. Extension-owned
// pgcrypto and vector functions are deliberately absent from the function list.
const EXPECTED_PERMANENT_TRIGGERS = [
  // Temporary #30453 old-API/new-DB delete bridge. Remove with #30468 after
  // the pre-#30453 API artifact is no longer eligible for rollback.
  CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_TRIGGER,
  {
    definition:
      "CREATE TRIGGER chat_events_reject_update BEFORE UPDATE ON public.chat_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_events",
    triggerName: "chat_events_reject_update",
  },
  // Temporary #30264 rolling floor. Phase B removes all five triggers and
  // functions after the released legacy zero-traffic observation gate.
  {
    definition:
      "CREATE TRIGGER force_legacy_morning_brief_disabled_1029 BEFORE INSERT OR UPDATE OF morning_brief_enabled ON public.org_members_metadata FOR EACH ROW EXECUTE FUNCTION force_legacy_morning_brief_disabled_1029()",
    schemaName: "public",
    tableName: "org_members_metadata",
    triggerName: "force_legacy_morning_brief_disabled_1029",
  },
  {
    definition:
      "CREATE TRIGGER pause_legacy_morning_brief_schedule_1029 BEFORE INSERT OR UPDATE OF next_run_at ON public.morning_brief_schedules FOR EACH ROW EXECUTE FUNCTION pause_legacy_morning_brief_schedule_1029()",
    schemaName: "public",
    tableName: "morning_brief_schedules",
    triggerName: "pause_legacy_morning_brief_schedule_1029",
  },
  {
    definition:
      "CREATE TRIGGER reject_legacy_morning_brief_delivery_1029 BEFORE INSERT OR UPDATE OF status, run_id, input_key, output_key ON public.morning_brief_deliveries FOR EACH ROW EXECUTE FUNCTION reject_legacy_morning_brief_delivery_1029()",
    schemaName: "public",
    tableName: "morning_brief_deliveries",
    triggerName: "reject_legacy_morning_brief_delivery_1029",
  },
  {
    definition:
      "CREATE TRIGGER reject_legacy_morning_brief_context_1029 BEFORE INSERT ON public.chat_morning_brief_context FOR EACH ROW EXECUTE FUNCTION reject_legacy_morning_brief_context_1029()",
    schemaName: "public",
    tableName: "chat_morning_brief_context",
    triggerName: "reject_legacy_morning_brief_context_1029",
  },
  {
    definition:
      "CREATE TRIGGER reject_legacy_morning_brief_email_1029 BEFORE INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION reject_legacy_morning_brief_email_1029()",
    schemaName: "public",
    tableName: "email_outbox",
    triggerName: "reject_legacy_morning_brief_email_1029",
  },
  // Temporary #29910 old-writer/new-DB bridges. Remove only with #28368's
  // separately reviewed legacy-acceptor contract after the production drain.
  {
    definition:
      "CREATE TRIGGER canonicalize_agent_run_builtin_provider BEFORE INSERT OR UPDATE OF model_provider ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION canonicalize_agent_run_builtin_provider()",
    schemaName: "public",
    tableName: "agent_runs",
    triggerName: "canonicalize_agent_run_builtin_provider",
  },
  {
    definition:
      "CREATE TRIGGER canonicalize_chat_thread_builtin_provider BEFORE INSERT OR UPDATE OF model_provider_type ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION canonicalize_chat_thread_builtin_provider()",
    schemaName: "public",
    tableName: "chat_threads",
    triggerName: "canonicalize_chat_thread_builtin_provider",
  },
  {
    definition:
      "CREATE TRIGGER canonicalize_model_provider_builtin_type BEFORE INSERT OR UPDATE ON public.model_providers FOR EACH ROW EXECUTE FUNCTION canonicalize_model_provider_builtin_type()",
    schemaName: "public",
    tableName: "model_providers",
    triggerName: "canonicalize_model_provider_builtin_type",
  },
  {
    definition:
      "CREATE TRIGGER canonicalize_org_model_policy_builtin_provider BEFORE INSERT OR UPDATE OF default_provider_type, model_provider_id, model_provider_surface_id ON public.org_model_policies FOR EACH ROW EXECUTE FUNCTION canonicalize_org_model_policy_builtin_provider()",
    schemaName: "public",
    tableName: "org_model_policies",
    triggerName: "canonicalize_org_model_policy_builtin_provider",
  },
  {
    definition:
      "CREATE TRIGGER allocate_legacy_chat_thread_event_seq_id BEFORE INSERT ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION allocate_legacy_chat_thread_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "allocate_legacy_chat_thread_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_thread_events_reject_update BEFORE UPDATE ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "chat_thread_events_reject_update",
  },
  {
    definition:
      "CREATE TRIGGER fill_legacy_chat_thread_snapshot_event_seq_id BEFORE INSERT OR UPDATE ON public.chat_thread_snapshots FOR EACH ROW EXECUTE FUNCTION fill_legacy_chat_thread_snapshot_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_snapshots",
    triggerName: "fill_legacy_chat_thread_snapshot_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_threads_normalize_computer_access BEFORE INSERT OR UPDATE OF computer_use_host_id, cloud_browser_enabled ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION chat_threads_normalize_computer_access()",
    schemaName: "public",
    tableName: "chat_threads",
    triggerName: "chat_threads_normalize_computer_access",
  },
  {
    definition:
      "CREATE TRIGGER enforce_hosted_deployment_scope_0753 BEFORE INSERT ON public.hosted_deployments FOR EACH ROW EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()",
    schemaName: "public",
    tableName: "hosted_deployments",
    triggerName: "enforce_hosted_deployment_scope_0753",
  },
  {
    definition:
      "CREATE TRIGGER canonicalize_hosted_site_scope_0753 BEFORE INSERT OR UPDATE OF created_from_run_id, requested_slug, chat_thread_id ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION canonicalize_hosted_site_scope_0753()",
    schemaName: "public",
    tableName: "hosted_sites",
    triggerName: "canonicalize_hosted_site_scope_0753",
  },
  {
    definition:
      "CREATE TRIGGER hosted_sites_delete_artifact_registry AFTER DELETE ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('hosted-site')",
    schemaName: "public",
    tableName: "hosted_sites",
    triggerName: "hosted_sites_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER image_artifacts_delete_artifact_registry AFTER DELETE ON public.image_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('image')",
    schemaName: "public",
    tableName: "image_artifacts",
    triggerName: "image_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER trg_org_custom_connector_oauth_configs_mode AFTER INSERT OR DELETE OR UPDATE ON public.org_custom_connector_oauth_configs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()",
    schemaName: "public",
    tableName: "org_custom_connector_oauth_configs",
    triggerName: "trg_org_custom_connector_oauth_configs_mode",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER trg_org_custom_connectors_oauth_mode AFTER INSERT OR UPDATE ON public.org_custom_connectors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()",
    schemaName: "public",
    tableName: "org_custom_connectors",
    triggerName: "trg_org_custom_connectors_oauth_mode",
  },
  {
    definition:
      "CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()",
    schemaName: "public",
    tableName: "org_metadata",
    triggerName: "ensure_legacy_org_metadata_plan_entitlement",
  },
  // Temporary #30379 expand/mirror bridge. Remove only with #28368 after the
  // backfill, canonical application/reporting switch, and rollback gates pass.
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER,
  // Temporary #30162 expand/mirror bridge. Remove only with #28368 after the
  // canonical reader/writer switch, backfill, and rollback drain are accepted.
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER,
  {
    definition:
      "CREATE TRIGGER sync_legacy_org_plan_entitlement_can_buy_credits BEFORE INSERT OR UPDATE OF plan_key ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_legacy_org_plan_entitlement_can_buy_credits()",
    schemaName: "public",
    tableName: "org_plan_entitlements",
    triggerName: "sync_legacy_org_plan_entitlement_can_buy_credits",
  },
  {
    definition:
      "CREATE TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed BEFORE INSERT OR UPDATE OF plan_key ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_legacy_org_plan_entitlement_member_invitation_allowed()",
    schemaName: "public",
    tableName: "org_plan_entitlements",
    triggerName: "sync_legacy_org_plan_entitlement_member_invitation_allowed",
  },
  {
    definition:
      "CREATE TRIGGER presentation_artifacts_delete_artifact_registry AFTER DELETE ON public.presentation_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('presentation')",
    schemaName: "public",
    tableName: "presentation_artifacts",
    triggerName: "presentation_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_delete_artifact_registry AFTER DELETE ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('file')",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_queue_artifact_catalog AFTER INSERT OR UPDATE OF run_id, chat_thread_id, user_id, org_id, external_id, filename, content_type, url, preview_image_url, metadata ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION queue_artifact_catalog_file()",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_queue_artifact_catalog",
  },
  {
    definition:
      "CREATE TRIGGER video_artifacts_delete_artifact_registry AFTER DELETE ON public.video_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('video')",
    schemaName: "public",
    tableName: "video_artifacts",
    triggerName: "video_artifacts_delete_artifact_registry",
  },
  // DB/API rollout bridge for #28304. Remove in #28372 after all pre-0954
  // pending snapshots and Checkout Sessions have drained or reconciled.
  {
    definition:
      "CREATE TRIGGER sync_usage_pack_pending_snapshot_guard_0954 AFTER INSERT OR DELETE OR UPDATE OF org_id, subscription_status ON public.usage_pack_subscriptions FOR EACH ROW EXECUTE FUNCTION sync_usage_pack_pending_snapshot_guard_0954()",
    schemaName: "public",
    tableName: "usage_pack_subscriptions",
    triggerName: "sync_usage_pack_pending_snapshot_guard_0954",
  },
] as const satisfies readonly PermanentTrigger[];

const EXPECTED_PERMANENT_FUNCTIONS = [
  // Same temporary #30453 bridge and #30468 removal gate as its trigger.
  CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_FUNCTION,
  // Same temporary #30264 bridge and phase-B removal gate as the triggers.
  {
    bodyHash: "44930ae5bfb57cee2cb3645f16abc8fb",
    functionName: "force_legacy_morning_brief_disabled_1029",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "b888804c00096033c0d80b03ae7181f5",
    functionName: "pause_legacy_morning_brief_schedule_1029",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "4d498817e1b718b455b034ae068a678b",
    functionName: "reject_legacy_morning_brief_delivery_1029",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "a652f4bc6cc488ef084432476fda6113",
    functionName: "reject_legacy_morning_brief_context_1029",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "0fedb75100b0bdde27915e5688d35fc0",
    functionName: "reject_legacy_morning_brief_email_1029",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  // Same temporary #29910 bridge and #28368 removal gate as the triggers.
  {
    bodyHash: "08ccacae72d432c06fecb49b4f01dcbf",
    functionName: "canonicalize_agent_run_builtin_provider",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "8184f2daa343c7eb811308c17a6a2b65",
    functionName: "canonicalize_chat_thread_builtin_provider",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "90eafccc4fe3a0ffa32dec184c340e77",
    functionName: "canonicalize_model_provider_builtin_type",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "dfd0098b8afe609bbbcd336b22f6ec3b",
    functionName: "canonicalize_org_model_policy_builtin_provider",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "6b1b5ad47ec35bcbaad3fa95d86ef027",
    functionName: "allocate_legacy_chat_thread_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "4886a7314cbaa815a4f8290a16a2f528",
    functionName: "assert_org_custom_connector_oauth_mode",
    identityArguments: "target_connector_id uuid, target_org_id text",
    kind: "f",
    schemaName: "public",
  },
  // Same #28304 DB/API rollout bridge and #28372 removal gate as its trigger.
  {
    bodyHash: "ced36d9b55fb6907880d545aa7f36dbe",
    functionName: "sync_usage_pack_pending_snapshot_guard_0954",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "3506554504d6ccad1b34008dab9a9e9a",
    functionName: "canonicalize_hosted_site_scope_0753",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7f12cb6026b4e6d6638aaa22e0a93514",
    functionName: "chat_threads_normalize_computer_access",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "3879e0228971b9f64e4bf8439ec5df4b",
    functionName: "delete_artifact_registry_entity",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "6f52cca2ad2bdcb63072a8c4269c9b49",
    functionName: "enforce_hosted_deployment_scope_0753",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "15e3309d90f7237e3b5c28fbf23a439d",
    functionName: "enforce_org_custom_connector_oauth_mode",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
  // Same temporary #30379 bridge and #28368 removal gate as its trigger.
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION,
  {
    bodyHash: "7740cf65befb5e06a73e1f21bcfdd5cc",
    functionName: "fill_legacy_chat_thread_snapshot_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "6e1e9c59353aa29b1e0ba58f1406e875",
    functionName: "queue_artifact_catalog_file",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "519c7504c787a49c4c6bea8a588711fc",
    functionName: "reject_chat_event_source_update",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  // Same temporary #30162 bridge and #28368 removal gate as its trigger.
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION,
  {
    bodyHash: "daf97695043bdbafd864f7ff7a8f8d5d",
    functionName: "sync_legacy_org_plan_entitlement_can_buy_credits",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "71b2b16ba3c75c485a4f01091ea02454",
    functionName: "sync_legacy_org_plan_entitlement_member_invitation_allowed",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
] as const satisfies readonly PermanentFunction[];

function assertPermanentInventory(args: {
  readonly actual: readonly string[];
  readonly expected: readonly string[];
  readonly label: string;
}): void {
  const actual = new Set(args.actual);
  const expected = new Set(args.expected);
  const missing = args.expected.filter((object) => {
    return !actual.has(object);
  });
  const unexpected = args.actual.filter((object) => {
    return !expected.has(object);
  });

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        `Permanent ${args.label} inventory mismatch`,
        `Missing ${args.label}: ${missing.join(", ") || "none"}`,
        `Unexpected ${args.label}: ${unexpected.join(", ") || "none"}`,
      ].join("\n"),
    );
  }
}

async function validatePermanentTriggerAndFunctionInventory(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1: Validate permanent trigger and function inventory ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // pg_get_triggerdef output depends on search_path.
    await client.query(`SET search_path TO public, pg_catalog`);
    const triggers = await client.query<PermanentTrigger>(`
      SELECT
        namespace."nspname" AS "schemaName",
        relation."relname" AS "tableName",
        catalog_trigger."tgname" AS "triggerName",
        pg_catalog.pg_get_triggerdef(catalog_trigger."oid") AS "definition"
      FROM pg_catalog."pg_trigger" AS catalog_trigger
      INNER JOIN pg_catalog."pg_class" AS relation
        ON relation."oid" = catalog_trigger."tgrelid"
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT catalog_trigger."tgisinternal"
      ORDER BY
        namespace."nspname",
        relation."relname",
        catalog_trigger."tgname"
    `);
    const functions = await client.query<PermanentFunction>(`
      SELECT
        namespace."nspname" AS "schemaName",
        catalog_function."proname" AS "functionName",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
          AS "identityArguments",
        catalog_function."prokind"::text AS "kind",
        pg_catalog.md5(catalog_function."prosrc") AS "bodyHash"
      FROM pg_catalog."pg_proc" AS catalog_function
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = catalog_function."pronamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog."pg_depend" AS dependency
          WHERE dependency."classid" = 'pg_catalog.pg_proc'::regclass
            AND dependency."objid" = catalog_function."oid"
            AND dependency."refclassid" = 'pg_catalog.pg_extension'::regclass
            AND dependency."deptype" = 'e'
        )
      ORDER BY
        namespace."nspname",
        catalog_function."proname",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
    `);

    const triggerKey = (trigger: PermanentTrigger): string => {
      return `${trigger.schemaName}.${trigger.tableName}.${trigger.triggerName} [${trigger.definition}]`;
    };
    const functionKey = (catalogFunction: PermanentFunction): string => {
      return `${catalogFunction.schemaName}.${catalogFunction.functionName}(${catalogFunction.identityArguments}) [${catalogFunction.kind}] [body md5=${catalogFunction.bodyHash}]`;
    };

    assertPermanentInventory({
      actual: triggers.rows.map(triggerKey),
      expected: EXPECTED_PERMANENT_TRIGGERS.map(triggerKey),
      label: "triggers",
    });
    assertPermanentInventory({
      actual: functions.rows.map(functionKey),
      expected: EXPECTED_PERMANENT_FUNCTIONS.map(functionKey),
      label: "functions",
    });

    console.log("   ✅ Permanent trigger and function inventories match\n");
  } finally {
    await client.end();
  }
}

async function validateActiveLegacyDatabaseIdentityInventory(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.1: Validate active legacy database identity inventory ===\n",
  );
  const snapshot = await discoverLatestLegacySnapshotIdentities(MIGRATIONS_DIR);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const catalog = await discoverReplayedCatalogLegacyIdentities(client);
    const semanticContracts = discoverPersistedSemanticLegacyIdentities(
      snapshot.snapshot,
    );
    const discovered = [
      ...snapshot.identities,
      ...catalog,
      ...semanticContracts,
    ];
    assertLegacyDatabaseIdentityInventory({
      discovered,
      manifest: LEGACY_DATABASE_IDENTITY_MANIFEST,
    });
    const counts = countLegacyIdentitiesByKind(discovered);
    const nonEmptyCounts = Object.entries(counts)
      .filter(([, count]) => {
        return count > 0;
      })
      .map(([kind, count]) => {
        return `${kind}=${count}`;
      })
      .join(", ");

    console.log(
      `   Latest snapshot: ${snapshot.migrationTag} (${snapshot.identities.length} identities)`,
    );
    console.log(`   Replayed catalog: ${catalog.length} identities`);
    console.log(
      `   Persisted semantic contracts: ${semanticContracts.length} families`,
    );
    console.log(`   Authoritative manifest: ${nonEmptyCounts}`);
    console.log(
      "   ✅ Active legacy database identity inventory matches exactly\n",
    );
  } finally {
    await client.end();
  }
}

async function validatePermanentArtifactTriggerBehavior(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.2: Validate permanent artifact trigger behavior ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const fixture = {
    agentId: "00000000-0000-4000-8000-000000246701",
    sessionId: "00000000-0000-4000-8000-000000246702",
    firstRunId: "00000000-0000-4000-8000-000000246703",
    secondRunId: "00000000-0000-4000-8000-000000246704",
    firstThreadId: "00000000-0000-4000-8000-000000246705",
    secondThreadId: "00000000-0000-4000-8000-000000246706",
    hostedSiteId: "00000000-0000-4000-8000-000000246707",
    presentationSiteId: "00000000-0000-4000-8000-000000246708",
    scopedSiteId: "00000000-0000-4000-8000-000000246709",
    directFileId: "00000000-0000-4000-8000-000000246710",
    queuedFileId: "00000000-0000-4000-8000-000000246711",
    imageFileId: "00000000-0000-4000-8000-000000246712",
    videoFileId: "00000000-0000-4000-8000-000000246713",
    imageId: "00000000-0000-4000-8000-000000246714",
    presentationId: "00000000-0000-4000-8000-000000246715",
    videoId: "00000000-0000-4000-8000-000000246716",
    orgId: "permanent-artifact-trigger-org",
    otherUserId: "permanent-artifact-trigger-other-user",
    userId: "permanent-artifact-trigger-user",
  } as const;
  const registryIds = [
    "00000000-0000-4000-8000-000000246721",
    "00000000-0000-4000-8000-000000246722",
    "00000000-0000-4000-8000-000000246723",
    "00000000-0000-4000-8000-000000246724",
    "00000000-0000-4000-8000-000000246725",
  ] as const;

  try {
    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, $2, $3, 'permanent-artifact-trigger-test')`,
      [fixture.agentId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "agent_sessions" (
         "id", "user_id", "org_id", "agent_id"
       )
       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.userId, fixture.orgId, fixture.agentId],
    );
    await client.query(
      `INSERT INTO "agent_runs" (
         "id", "user_id", "session_id", "status", "prompt", "org_id"
       )
       VALUES
         ($1, $3, $4, 'running', 'first scoped deployment', $5),
         ($2, $3, $4, 'running', 'second scoped deployment', $5)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    );
    await client.query(
      `INSERT INTO "chat_threads" (
         "id", "user_id", "agent_id", "title"
       )
       VALUES
         ($1, $3, $4, 'First permanent artifact trigger chat'),
         ($2, $5, $4, 'Second permanent artifact trigger chat')`,
      [
        fixture.firstThreadId,
        fixture.secondThreadId,
        fixture.userId,
        fixture.agentId,
        fixture.otherUserId,
      ],
    );
    await client.query(
      `UPDATE "agent_runs"
       SET
         "trigger_source" = 'chat',
         "autonomy_budget" = 10,
         "chat_thread_id" = CASE
           WHEN "id" = $1 THEN $3::uuid
           ELSE $4::uuid
         END
       WHERE "id" IN ($1, $2)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.firstThreadId,
        fixture.secondThreadId,
      ],
    );
    await client.query(
      `INSERT INTO "run_uploaded_files" (
         "id", "source", "external_id", "user_id", "org_id", "url",
         "run_id"
       )
       VALUES
         ($1, 'web', 'direct-file', $5, NULL, NULL, NULL),
         ($2, 'web', 'queued-file', $5, $6,
          'https://example.invalid/queued-file', $7),
         ($3, 'web', 'image-file', $5, NULL, NULL, NULL),
         ($4, 'web', 'video-file', $5, NULL, NULL, NULL)`,
      [
        fixture.directFileId,
        fixture.queuedFileId,
        fixture.imageFileId,
        fixture.videoFileId,
        fixture.userId,
        fixture.orgId,
        fixture.firstRunId,
      ],
    );
    const queuedFile = await client.query<{
      authorUserId: string;
      orgId: string;
    }>(
      `SELECT
         "author_user_id" AS "authorUserId",
         "org_id" AS "orgId"
       FROM "artifact_catalog_pending_files"
       WHERE "file_id" = $1`,
      [fixture.queuedFileId],
    );
    assert.deepEqual(queuedFile.rows, [
      { authorUserId: fixture.userId, orgId: fixture.orgId },
    ]);

    await client.query(
      `INSERT INTO "hosted_sites" (
         "id", "org_id", "user_id", "slug", "public_slug",
         "requested_slug", "chat_thread_id", "created_from_run_id",
         "public_brand"
       )
       VALUES
         ($1, $4, $5, 'permanent-hosted-site', 'permanent-hosted-site',
          'permanent-hosted-site', NULL, $7, 'vm0'),
         ($2, $4, $5, 'permanent-presentation', 'permanent-presentation',
          'permanent-presentation', NULL, NULL, 'vm0'),
         ($3, $4, $5, 'permanent-scoped-site', 'permanent-scoped-site',
          'permanent-scoped-site', $6, NULL, 'vm0')`,
      [
        fixture.hostedSiteId,
        fixture.presentationSiteId,
        fixture.scopedSiteId,
        fixture.orgId,
        fixture.userId,
        fixture.firstThreadId,
        fixture.firstRunId,
      ],
    );
    const canonicalizedSite = await client.query<{ chatThreadId: string }>(
      `SELECT "chat_thread_id" AS "chatThreadId"
       FROM "hosted_sites"
       WHERE "id" = $1`,
      [fixture.hostedSiteId],
    );
    assert.deepEqual(canonicalizedSite.rows, [
      { chatThreadId: fixture.firstThreadId },
    ]);
    await client.query(
      `INSERT INTO "image_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.imageId, fixture.imageFileId],
    );
    await client.query(
      `INSERT INTO "presentation_artifacts" ("id", "hosted_site_id")
       VALUES ($1, $2)`,
      [fixture.presentationId, fixture.presentationSiteId],
    );
    await client.query(
      `INSERT INTO "video_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.videoId, fixture.videoFileId],
    );
    await client.query(
      `INSERT INTO "artifacts" (
         "id", "org_id", "author_user_id", "kind", "entity_id",
         "logical_key", "projection_file_id", "projection_created_at", "title"
       )
       VALUES
         ($1, $6, $7, 'hosted-site', $8, 'permanent-hosted-site', $9, now(), 'Hosted site'),
         ($2, $6, $7, 'image', $10, 'permanent-image', $11, now(), 'Image'),
         ($3, $6, $7, 'presentation', $12, 'permanent-presentation', $13, now(), 'Presentation'),
         ($4, $6, $7, 'video', $14, 'permanent-video', $15, now(), 'Video'),
         ($5, $6, $7, 'file', $16, 'permanent-file', $16, now(), 'File')`,
      [
        ...registryIds,
        fixture.orgId,
        fixture.userId,
        fixture.hostedSiteId,
        fixture.directFileId,
        fixture.imageId,
        fixture.imageFileId,
        fixture.presentationId,
        fixture.queuedFileId,
        fixture.videoId,
        fixture.videoFileId,
        fixture.directFileId,
      ],
    );

    await client.query(`DELETE FROM "hosted_sites" WHERE "id" = $1`, [
      fixture.hostedSiteId,
    ]);
    await client.query(`DELETE FROM "image_artifacts" WHERE "id" = $1`, [
      fixture.imageId,
    ]);
    await client.query(`DELETE FROM "presentation_artifacts" WHERE "id" = $1`, [
      fixture.presentationId,
    ]);
    await client.query(`DELETE FROM "video_artifacts" WHERE "id" = $1`, [
      fixture.videoId,
    ]);
    await client.query(`DELETE FROM "run_uploaded_files" WHERE "id" = $1`, [
      fixture.directFileId,
    ]);

    const remainingRegistryRows = await client.query<{ kind: string }>(
      `SELECT "kind"
       FROM "artifacts"
       WHERE "id" = ANY($1::uuid[])
       ORDER BY "kind"`,
      [[...registryIds]],
    );
    assert.deepEqual(remainingRegistryRows.rows, []);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "Hosted site belongs to a different chat",
      query: `INSERT INTO "hosted_deployments" (
        "site_id", "org_id", "user_id", "run_id", "status", "r2_prefix",
        "manifest", "manifest_hash", "content_hash", "file_count",
        "size_bytes", "url", "public_brand"
      )
      VALUES (
        $1, $2, $3, $4, 'uploading', 'permanent-out-of-scope', '{}'::jsonb,
        repeat('0', 64), repeat('0', 64), 0, 0,
        'https://out-of-scope.invalid', 'vm0'
      )`,
      values: [
        fixture.scopedSiteId,
        fixture.orgId,
        fixture.userId,
        fixture.secondRunId,
      ],
    });

    console.log(
      "   ✅ Artifact registry cascades, catalog queueing, and hosted deployment scope enforcement work\n",
    );
  } finally {
    await client.query(`DELETE FROM "artifacts" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_deployments" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_sites" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(
      `DELETE FROM "run_uploaded_files" WHERE "user_id" = $1`,
      [fixture.userId],
    );
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [
      fixture.agentId,
    ]);
    await client.end();
  }
}

async function validatePermanentAgentRunMetadataState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.3: Validate permanent agent-run metadata state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000270951",
    lifecycleRunId: "00000000-0000-4000-8000-000000270953",
    outOfRangeRunId: "00000000-0000-4000-8000-000000270955",
    partialRunId: "00000000-0000-4000-8000-000000270954",
    productRunId: "00000000-0000-4000-8000-000000270952",
    sessionId: "00000000-0000-4000-8000-000000270950",
    orgId: "permanent-agent-run-metadata-org",
    userId: "permanent-agent-run-metadata-user",
  } as const;

  try {
    const constraints = await client.query<{
      definition: string;
      name: string;
      validated: boolean;
    }>(`
      SELECT
        "conname" AS "name",
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" IN (
          'agent_runs_autonomy_budget_check',
          'agent_runs_metadata_presence_check'
        )
      ORDER BY "conname"
    `);
    assert.deepEqual(
      constraints.rows.map((constraint) => {
        return { name: constraint.name, validated: constraint.validated };
      }),
      [
        { name: "agent_runs_autonomy_budget_check", validated: true },
        { name: "agent_runs_metadata_presence_check", validated: true },
      ],
    );
    const metadataPresence = constraints.rows.find((constraint) => {
      return constraint.name === "agent_runs_metadata_presence_check";
    });
    assert.ok(metadataPresence);
    const metadataColumns = [
      "trigger_source",
      "autonomy_budget",
      "workflow_automation_id",
      "goal_id",
      "model_provider",
      "model_provider_id",
      "model_provider_credential_scope",
      "selected_model",
      "model_runtime_provider",
      "model_runtime_model",
      "built_in_model_key_id",
      "codex_service_tier",
      "selected_video_model",
      "selected_image_model",
      "chat_thread_id",
      "api_started_at",
      "first_assistant_event_acknowledged_at",
      "summary",
      "trigger_brief",
    ] as const;
    for (const column of metadataColumns) {
      assert.ok(metadataPresence.definition.includes(`${column} IS NULL`));
    }
    assert.ok(
      metadataPresence.definition.includes("trigger_source IS NOT NULL"),
    );
    assert.ok(
      metadataPresence.definition.includes("autonomy_budget IS NOT NULL"),
    );

    const discriminators = await client.query<{
      columnDefault: string | null;
      columnName: string;
      isNullable: string;
    }>(`
      SELECT
        "column_name" AS "columnName",
        "is_nullable" AS "isNullable",
        "column_default" AS "columnDefault"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'agent_runs'
        AND "column_name" IN ('trigger_source', 'autonomy_budget')
      ORDER BY "column_name"
    `);
    assert.deepEqual(discriminators.rows, [
      {
        columnDefault: null,
        columnName: "autonomy_budget",
        isNullable: "YES",
      },
      {
        columnDefault: null,
        columnName: "trigger_source",
        isNullable: "YES",
      },
    ]);

    const retiredPhysicalState = await client.query<{
      constraintCount: number;
      physicalRelationCount: number;
      rewriteReferenceCount: number;
      routineReferenceCount: number;
      tableAbsent: boolean;
      transitionRoutineCount: number;
      transitionTriggerCount: number;
    }>(`
      SELECT
        to_regclass('public.zero_runs') IS NULL AS "tableAbsent",
        (
          SELECT count(*)::integer
          FROM "pg_class" AS "relation_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "relation_row"."relnamespace"
          WHERE "namespace_row"."nspname" = 'public'
            AND "relation_row"."relname" IN (
              'zero_runs',
              'zero_runs_pkey',
              'idx_zero_runs_chat_thread_id',
              'idx_zero_runs_workflow_automation',
              'idx_zero_runs_goal'
            )
        ) AS "physicalRelationCount",
        (
          SELECT count(*)::integer
          FROM "pg_constraint"
          WHERE "conname" LIKE 'zero_runs_%'
        ) AS "constraintCount",
        (
          SELECT count(*)::integer
          FROM "pg_trigger"
          WHERE "tgname" = 'sync_zero_run_metadata_to_agent_runs'
            AND NOT "tgisinternal"
        ) AS "transitionTriggerCount",
        (
          SELECT count(*)::integer
          FROM "pg_proc" AS "routine_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "routine_row"."pronamespace"
          WHERE "namespace_row"."nspname" = 'public'
            AND "routine_row"."proname" IN (
              'sync_zero_run_metadata_to_agent_runs',
              'backfill_agent_run_metadata_stage2'
            )
        ) AS "transitionRoutineCount",
        (
          SELECT count(*)::integer
          FROM "pg_proc" AS "routine_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "routine_row"."pronamespace"
          WHERE "routine_row"."prokind" IN ('f', 'p')
            AND "namespace_row"."nspname" NOT IN (
              'pg_catalog',
              'information_schema'
            )
            AND pg_get_functiondef("routine_row"."oid") ILIKE '%zero_runs%'
        ) AS "routineReferenceCount",
        (
          SELECT count(*)::integer
          FROM "pg_rewrite" AS "rewrite_row"
          WHERE pg_get_ruledef("rewrite_row"."oid") ILIKE '%zero_runs%'
        ) AS "rewriteReferenceCount"
    `);
    assert.deepEqual(retiredPhysicalState.rows, [
      {
        constraintCount: 0,
        physicalRelationCount: 0,
        rewriteReferenceCount: 0,
        routineReferenceCount: 0,
        tableAbsent: true,
        transitionRoutineCount: 0,
        transitionTriggerCount: 0,
      },
    ]);

    const metadataReaders = await client.query<{
      body: string;
      name: string;
    }>(`
      SELECT "proname" AS "name", "prosrc" AS "body"
      FROM "pg_proc"
      WHERE "pronamespace" = 'public'::regnamespace
        AND "proname" IN (
          'canonicalize_hosted_site_scope_0753',
          'enforce_hosted_deployment_scope_0753',
          'queue_artifact_catalog_file'
        )
      ORDER BY "proname"
    `);
    assert.equal(metadataReaders.rows.length, 3);
    for (const reader of metadataReaders.rows) {
      assert.ok(reader.body.includes('FROM "agent_runs"'));
      assert.ok(reader.body.includes('"trigger_source" IS NOT NULL'));
      assert.ok(!reader.body.includes('"zero_runs"'));
    }

    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, $2, $3, 'permanent-agent-run-metadata')`,
      [fixture.agentId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "agent_sessions" (
         "id", "user_id", "org_id", "agent_id"
       ) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.userId, fixture.orgId, fixture.agentId],
    );
    await client.query(
      `INSERT INTO "agent_runs" (
         "id", "user_id", "session_id", "status", "prompt", "org_id"
       ) VALUES
         ($1, $3, $4, 'failed', 'durable lifecycle-only history', $5),
         ($2, $3, $4, 'completed', 'valid product run', $5)`,
      [
        fixture.lifecycleRunId,
        fixture.productRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    );
    await client.query(
      `UPDATE "agent_runs"
       SET "trigger_source" = 'chat', "autonomy_budget" = 10
       WHERE "id" = $1`,
      [fixture.productRunId],
    );
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_metadata_presence_check",
      query: `INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source"
      ) VALUES ($1, $2, $3, 'failed', 'partial metadata', $4, 'chat')`,
      values: [
        fixture.partialRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_metadata_presence_check",
      query: `UPDATE "agent_runs" SET "summary" = 'invented provenance'
        WHERE "id" = $1`,
      values: [fixture.lifecycleRunId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_autonomy_budget_check",
      query: `INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source", "autonomy_budget"
      ) VALUES ($1, $2, $3, 'failed', 'invalid budget', $4, 'chat', 11)`,
      values: [
        fixture.outOfRangeRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    });

    const validStates = await client.query<{
      autonomyBudget: number | null;
      id: string;
      summary: string | null;
      triggerSource: string | null;
    }>(
      `
      SELECT
        "id"::text AS "id",
        "trigger_source" AS "triggerSource",
        "autonomy_budget" AS "autonomyBudget",
        "summary"
      FROM "agent_runs"
      WHERE "id" IN ($1, $2)
      ORDER BY "id"
    `,
      [fixture.productRunId, fixture.lifecycleRunId],
    );
    assert.deepEqual(validStates.rows, [
      {
        autonomyBudget: 10,
        id: fixture.productRunId,
        summary: null,
        triggerSource: "chat",
      },
      {
        autonomyBudget: null,
        id: fixture.lifecycleRunId,
        summary: null,
        triggerSource: null,
      },
    ]);

    console.log(
      "   ✅ nullable two-state metadata, range, permanent readers, and physical zero_runs removal are enforced\n",
    );
  } finally {
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [
      fixture.agentId,
    ]);
    await client.end();
  }
}

async function validateConnectorCatalogFinalConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.6: Validate final connector catalog constraints ===\n",
  );
  const attemptConstraint =
    "connector_catalog_sync_state_attempt_cache_reuse_complete";
  const candidateConstraint =
    "connector_catalog_sync_state_rejected_candidate_complete";
  const authorityConstraint =
    "connector_catalog_sync_state_rejection_authority_complete";

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO "connector_catalog_sync_state" (
        "source_id",
        "schema_version",
        "last_attempt_at",
        "last_attempt_outcome",
        "last_attempt_reused_cached_rejection",
        "last_failure_code",
        "last_rejected_catalog_version",
        "last_rejected_catalog_key",
        "last_rejected_catalog_digest",
        "last_rejected_pointer_etag",
        "last_rejected_failure_code",
        "last_rejected_backend_version",
        "last_rejected_build_commit_sha"
      )
      VALUES
        (
          'migration-final-catalog-accepted',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          FALSE,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        ),
        (
          'migration-final-catalog-rejected',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          TRUE,
          'invalid-artifact',
          '2026-07-25.1',
          'connectors/v1/releases/2026-07-25.1/catalog.json',
          'sha256:${"b".repeat(64)}',
          '"final-authority-etag"',
          'invalid-artifact',
          '1.319.0',
          '${"a".repeat(40)}'
        )
    `);
    const validRows = await client.query<{ source_id: string }>(`
      SELECT "source_id"
      FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
      ORDER BY "source_id"
    `);
    assert.deepEqual(
      validRows.rows.map((row) => {
        return row.source_id;
      }),
      ["migration-final-catalog-accepted", "migration-final-catalog-rejected"],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_attempt_reused_cached_rejection")
        VALUES ('invalid-provenance-without-attempt', 1, FALSE)
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_failure_code"
        )
        VALUES (
          'invalid-missing-attempt-provenance',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          'source-unavailable'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_attempt_reused_cached_rejection"
        )
        VALUES (
          'invalid-reused-accepted-attempt',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          TRUE
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: candidateConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-partial-rejected-candidate',
          1,
          '2026-07-25.2',
          'invalid-artifact',
          '1.319.0'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_catalog_key",
          "last_rejected_catalog_digest",
          "last_rejected_failure_code"
        )
        VALUES (
          'invalid-candidate-without-authority',
          1,
          '2026-07-25.3',
          'connectors/v1/releases/2026-07-25.3/catalog.json',
          'sha256:${"c".repeat(64)}',
          'invalid-artifact'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_rejected_backend_version")
        VALUES ('invalid-authority-without-candidate', 1, '1.319.0')
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-rejection-backend-version',
          1,
          '"invalid-version-etag"',
          'invalid-pointer',
          '1.319.0-rc.1'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version",
          "last_rejected_build_commit_sha"
        )
        VALUES (
          'invalid-rejection-build-commit',
          1,
          '"invalid-build-etag"',
          'invalid-pointer',
          '1.319.0',
          '${"d".repeat(39)}'
        )
      `,
    });

    await client.query(`
      DELETE FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
    `);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Final connector catalog constraints accept complete state and reject ambiguous state\n",
  );
}

async function expectDeferredDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly messageIncludes?: string;
    readonly statements: readonly {
      readonly query: string;
      readonly values?: readonly string[];
    }[];
  },
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of args.statements) {
      await client.query(
        statement.query,
        statement.values ? [...statement.values] : undefined,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    assert.equal(databaseErrorCode(error), args.code);
    if (args.messageIncludes !== undefined) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(args.messageIncludes));
    }
    return;
  }
  throw new Error(`Expected deferred database error ${args.code}`);
}

async function validateCustomConnectorOauthModeConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.7: Validate custom connector OAuth mode constraints ===\n",
  );
  const fixture = {
    orgId: "migration-custom-connector-oauth-org",
    createdBy: "migration-custom-connector-oauth-user",
    manualConnectorId: "72000000-0000-4000-8000-000000000001",
    oauthConnectorId: "72000000-0000-4000-8000-000000000002",
    invalidOauthConnectorId: "72000000-0000-4000-8000-000000000003",
  } as const;
  const insertConnector = `
    INSERT INTO "org_custom_connectors" (
      "id",
      "org_id",
      "slug",
      "display_name",
      "prefix_templates",
      "fields",
      "header_injections",
      "query_injections",
      "auth_mode",
      "created_by"
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      '["https://api.example.test/"]'::jsonb,
      CASE
        WHEN $5 = 'manual' THEN '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb
        ELSE '[]'::jsonb
      END,
      CASE
        WHEN $5 = 'manual' THEN '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb
        ELSE '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb
      END,
      '[]'::jsonb,
      $5,
      $6
    )
  `;
  const insertOauthConfig = `
    INSERT INTO "org_custom_connector_oauth_configs" (
      "connector_id",
      "org_id",
      "provider_adapter",
      "client_id",
      "encrypted_client_secret",
      "authorization_url",
      "token_url",
      "token_endpoint_auth_method",
      "pkce_method"
    )
    VALUES (
      $1,
      $2,
      'standard',
      'migration-client',
      'migration-encrypted-secret',
      'https://oauth.example.test/authorize',
      'https://oauth.example.test/token',
      'client_secret_basic',
      'none'
    )
  `;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query(insertConnector, [
      fixture.manualConnectorId,
      fixture.orgId,
      "_migration_manual",
      "Migration Manual Connector",
      "manual",
      fixture.createdBy,
    ]);

    await client.query("BEGIN");
    await client.query(insertConnector, [
      fixture.oauthConnectorId,
      fixture.orgId,
      "_migration_oauth",
      "Migration OAuth Connector",
      "oauth",
      fixture.createdBy,
    ]);
    await client.query(insertOauthConfig, [
      fixture.oauthConnectorId,
      fixture.orgId,
    ]);
    await client.query("COMMIT");

    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: insertConnector,
          values: [
            fixture.invalidOauthConnectorId,
            fixture.orgId,
            "_migration_invalid_oauth",
            "Migration Invalid OAuth Connector",
            "oauth",
            fixture.createdBy,
          ],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: insertOauthConfig,
          values: [fixture.manualConnectorId, fixture.orgId],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: `
            UPDATE "org_custom_connectors"
            SET "auth_mode" = 'manual'
            WHERE "id" = $1
          `,
          values: [fixture.oauthConnectorId],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: `
            DELETE FROM "org_custom_connector_oauth_configs"
            WHERE "connector_id" = $1
          `,
          values: [fixture.oauthConnectorId],
        },
      ],
    });

    await client.query(
      `
        DELETE FROM "org_custom_connectors"
        WHERE "id" IN ($1, $2)
      `,
      [fixture.manualConnectorId, fixture.oauthConnectorId],
    );
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Deferred constraints accept complete modes and reject mismatched OAuth configuration\n",
  );
}

async function validateCustomConnectorSkillVersionPair(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.8: Validate custom connector skill version pair ===\n",
  );
  const fixture = {
    connectorId: "73000000-0000-4000-8000-000000000001",
    orgId: "migration-custom-connector-skill-org",
    storageId: "73000000-0000-4000-8000-000000000002",
    userId: "migration-custom-connector-skill-user",
    versionId: "7".repeat(64),
  } as const;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query(
      `
        INSERT INTO "storages" (
          "id", "user_id", "name", "org_id", "s3_prefix"
        ) VALUES ($1, '__org__', '_migration_skill_storage', $2, $3)
      `,
      [
        fixture.storageId,
        fixture.orgId,
        `${fixture.orgId}/volume/_migration_skill_storage`,
      ],
    );
    await client.query(
      `
        INSERT INTO "storage_versions" (
          "id", "storage_id", "s3_key", "archive_size", "created_by"
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [
        fixture.versionId,
        fixture.storageId,
        `${fixture.orgId}/volume/_migration_skill_storage/${fixture.versionId}`,
        fixture.userId,
      ],
    );
    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "auth_mode",
          "created_by"
        ) VALUES (
          $1,
          $2,
          '_migration_skill_pair',
          'Migration Skill Pair',
          '["https://api.example.test/"]'::jsonb,
          '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
          '[]'::jsonb,
          'manual',
          $3
        )
      `,
      [fixture.connectorId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `
        UPDATE "org_custom_connectors"
        SET
          "skill_markdown" = 'Use the migration skill.',
          "skill_storage_version_id" = $2
        WHERE "id" = $1
      `,
      [fixture.connectorId, fixture.versionId],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_skill_version_pair",
      query: `
        UPDATE "org_custom_connectors"
        SET "skill_markdown" = NULL
        WHERE "id" = $1
      `,
      values: [fixture.connectorId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_skill_version_pair",
      query: `
        UPDATE "org_custom_connectors"
        SET "skill_storage_version_id" = NULL
        WHERE "id" = $1
      `,
      values: [fixture.connectorId],
    });

    await client.query(
      `
        UPDATE "org_custom_connectors"
        SET "skill_markdown" = NULL, "skill_storage_version_id" = NULL
        WHERE "id" = $1
      `,
      [fixture.connectorId],
    );
    await client.query(`DELETE FROM "org_custom_connectors" WHERE "id" = $1`, [
      fixture.connectorId,
    ]);
    await client.query(`DELETE FROM "storages" WHERE "id" = $1`, [
      fixture.storageId,
    ]);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Custom connector skill columns accept complete pairs and reject mixed state\n",
  );
}

interface ExtractedSchema {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
  indexes: Map<string, Set<string>>;
  constraints: Map<string, Set<string>>;
}

function groupSchemaObjects(
  rows: Array<{ object_name: string; table_name: string }>,
): Map<string, Set<string>> {
  const objects = new Map<string, Set<string>>();
  for (const row of rows) {
    const tableObjects = objects.get(row.table_name) ?? new Set<string>();
    tableObjects.add(row.object_name);
    objects.set(row.table_name, tableObjects);
  }
  return objects;
}

async function extractSchemaFromDb(dbUrl: string): Promise<ExtractedSchema> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '__drizzle_migrations'
      ORDER BY table_name
    `);

    const tables = new Set<string>(
      tablesResult.rows.map((r) => {
        return r.table_name;
      }),
    );
    const columns = new Map<string, Set<string>>();

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns
      const columnsResult = await client.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY column_name
      `,
        [tableName],
      );

      columns.set(
        tableName,
        new Set(
          columnsResult.rows.map((c) => {
            return c.column_name;
          }),
        ),
      );
    }

    const indexesResult = await client.query<{
      object_name: string;
      table_name: string;
    }>(`
      SELECT
        "tablename" AS "table_name",
        "indexname" AS "object_name"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
      ORDER BY "tablename", "indexname"
    `);
    const constraintsResult = await client.query<{
      object_name: string;
      table_name: string;
    }>(`
      SELECT
        "relation"."relname" AS "table_name",
        "constraint"."conname" AS "object_name"
      FROM "pg_constraint" AS "constraint"
      JOIN "pg_class" AS "relation"
        ON "relation"."oid" = "constraint"."conrelid"
      JOIN "pg_namespace" AS "namespace"
        ON "namespace"."oid" = "relation"."relnamespace"
      WHERE "namespace"."nspname" = 'public'
        AND "constraint"."contype" = 'p'
      ORDER BY "relation"."relname", "constraint"."conname"
    `);

    return {
      tables,
      columns,
      indexes: groupSchemaObjects(indexesResult.rows),
      constraints: groupSchemaObjects(constraintsResult.rows),
    };
  } finally {
    await client.end();
  }
}

interface SnapshotTable {
  name?: string;
  columns?: Record<string, unknown>;
  indexes?: Record<string, unknown>;
  compositePrimaryKeys?: Record<string, unknown>;
}

function extractSchemaFromSnapshot(snapshotPath: string): ExtractedSchema {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
    tables?: Record<string, SnapshotTable>;
  };
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const indexes = new Map<string, Set<string>>();
  const constraints = new Map<string, Set<string>>();

  for (const [tableKey, tableData] of Object.entries(snapshot.tables || {})) {
    // Normalize table name: extract actual table name from the key
    // Could be "users" or "public.users", we want just "users"
    const tableName = tableData.name || tableKey.replace(/^public\./, "");
    tables.add(tableName);

    const tableColumns = new Set<string>(Object.keys(tableData.columns || {}));
    columns.set(tableName, tableColumns);
    const primaryKeys = Object.keys(tableData.compositePrimaryKeys || {});
    indexes.set(
      tableName,
      new Set([...Object.keys(tableData.indexes || {}), ...primaryKeys]),
    );
    constraints.set(tableName, new Set(primaryKeys));
  }

  return { tables, columns, indexes, constraints };
}

function compareSchemas(
  dbSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  snapshotSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  migrationIdx: number,
): { matches: boolean; differences: string[] } {
  const differences: string[] = [];

  // Compare tables
  const dbTables = Array.from(dbSchema.tables).sort();
  const snapshotTables = Array.from(snapshotSchema.tables).sort();

  const missingInSnapshot = dbTables.filter((t) => {
    return !snapshotTables.includes(t);
  });
  const extraInSnapshot = snapshotTables.filter((t) => {
    return !dbTables.includes(t);
  });

  if (missingInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in DB but not in snapshot: ${missingInSnapshot.join(", ")}`,
    );
  }
  if (extraInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in snapshot but not in DB: ${extraInSnapshot.join(", ")}`,
    );
  }

  // Compare columns for each table
  for (const tableName of dbTables) {
    if (!snapshotSchema.columns.has(tableName)) continue;

    const dbCols = Array.from(dbSchema.columns.get(tableName) || []).sort();
    const snapshotCols = Array.from(
      snapshotSchema.columns.get(tableName) || [],
    ).sort();

    const missingCols = dbCols.filter((column) => {
      return !snapshotCols.includes(column);
    });
    const extraCols = snapshotCols.filter((c) => {
      return !dbCols.includes(c);
    });

    if (missingCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in DB but not in snapshot: ${missingCols.join(", ")}`,
      );
    }
    if (extraCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in snapshot but not in DB: ${extraCols.join(", ")}`,
      );
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

async function validateTimestampOrdering(): Promise<void> {
  console.log("=== Phase 0.5: Validate Journal Timestamp Ordering ===\n");

  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{
    idx: number;
    tag: string;
    when: number;
  }>;

  if (entries.length < 2) {
    console.log("   Skipping (fewer than 2 migrations)\n");
    return;
  }

  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    if (curr.when <= prev.when) {
      const diffMs = prev.when - curr.when;
      const diffDays = (diffMs / (1000 * 60 * 60 * 24)).toFixed(1);
      violations.push(
        `   ${String(prev.idx).padStart(4, "0")} ${prev.tag} (when=${prev.when}) → ` +
          `${String(curr.idx).padStart(4, "0")} ${curr.tag} (when=${curr.when}) — ` +
          `timestamp goes BACKWARDS by ${diffDays} days`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `   ❌ Found ${violations.length} timestamp ordering violation(s):\n`,
    );
    for (const v of violations) {
      console.error(v);
    }
    console.error(
      `\n   Drizzle's migrator only applies migrations whose timestamp`,
    );
    console.error(`   is greater than the last applied migration's timestamp.`);
    console.error(
      `   Out-of-order timestamps cause migrations to be SKIPPED in production.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(
      `      Update the "when" values in meta/_journal.json so that`,
    );
    console.error(
      `      each entry's timestamp is strictly greater than the previous one.`,
    );
    console.error(
      `      For example, set the violating entry's "when" to prev.when + 1.\n`,
    );
    throw new Error("Journal timestamp ordering violation");
  }

  console.log(
    `   ✅ All ${entries.length} migrations have strictly increasing timestamps`,
  );
  console.log();
}

const RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_PREVIOUS_MIGRATION =
  "0809_clean_kronos";
const RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_MIGRATION = "0810_small_sway";

async function addCurrentChatEventPayloadStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    ADD COLUMN "payload" jsonb
  `);
  await addCurrentChatEventOfficialWorkflowQueueStorage(client);
}

async function addCurrentChatEventOfficialWorkflowQueueStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    ADD COLUMN "required_official_workflow_ids" uuid[]
  `);
}

async function removeCurrentChatEventOfficialWorkflowQueueStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    DROP COLUMN "required_official_workflow_ids"
  `);
}

async function addCurrentChatEventAdditiveStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    ADD COLUMN "active_input_sequence" integer
  `);
  await addCurrentChatEventPayloadStorage(client);
}

async function validateRunEventSequenceNumberRollout(): Promise<void> {
  console.log(
    "=== Validate populated run event sequence expand, switch, and contract rollout ===\n",
  );
  const testDb = "migration_run_event_sequence_number_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "00000000-0000-4000-8000-000000080701";
  const threadId = "00000000-0000-4000-8000-000000080702";
  const historicalRunId = "00000000-0000-4000-8000-000000080703";
  const previousApiRunId = "00000000-0000-4000-8000-000000080704";
  const currentApiRunId = "00000000-0000-4000-8000-000000080705";
  const contractedRunId = "00000000-0000-4000-8000-000000080706";

  const contractionSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0810_small_sway.sql"),
    "utf8",
  );
  assert.ok(contractionSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.equal(
    (
      contractionSql.match(
        /DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_seq_unique"/gu,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    contractionSql,
    /DROP TRIGGER IF EXISTS "bridge_chat_event_run_event_sequence_number_0807"/u,
  );
  assert.match(
    contractionSql,
    /DROP FUNCTION IF EXISTS "bridge_chat_event_run_event_sequence_number_0807"\(\)/u,
  );
  assert.match(contractionSql, /DROP COLUMN IF EXISTS "sequence_number"/u);
  assert.doesNotMatch(
    contractionSql,
    /CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"/u,
  );
  assert.doesNotMatch(
    contractionSql,
    /"seq_id"|"last_chat_event_seq_id"|"run_event_id"|"chat_events_run_event_seq_unique"/u,
  );

  const schemaSource = await fs.readFile(
    path.join(PACKAGE_DIR, "src/schema/chat-event.ts"),
    "utf8",
  );
  assert.match(
    schemaSource,
    /runEventSequenceNumber: integer\("run_event_sequence_number"\)/u,
  );
  assert.doesNotMatch(
    schemaSource,
    /sequenceNumber: integer\("sequence_number"\)/u,
  );

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'run-event-sequence-test-user',
            'run-event-sequence-test',
            'run-event-sequence-test-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "title"
          )
          VALUES (
            $1,
            'run-event-sequence-test-user',
            $2,
            'run event sequence expansion test'
          )
        `,
        [threadId, composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          SELECT
            $1,
            $2,
            'output.message',
            "sequence",
            "sequence"
          FROM generate_series(1, 10001) AS "sequence"
        `,
        [threadId, historicalRunId],
      );

      await addCurrentChatEventAdditiveStorage(client);
      const database = drizzle(client);

      const historicalRows = await client.query<{
        mismatches: string;
        rows: string;
      }>(
        `
          SELECT
            count(*)::text AS "rows",
            count(*) FILTER (
              WHERE "run_event_sequence_number"
                IS DISTINCT FROM "sequence_number"
            )::text AS "mismatches"
          FROM "chat_events"
          WHERE "run_id" = $1
        `,
        [historicalRunId],
      );
      assert.deepEqual(historicalRows.rows, [
        { mismatches: "0", rows: "10001" },
      ]);

      const previousApiInsert = await client.query<{
        id: string;
        runEventSequenceNumber: number;
        sequenceNumber: number;
      }>(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 7, 10002)
          ON CONFLICT ("run_id", "sequence_number") DO NOTHING
          RETURNING
            "id",
            "sequence_number" AS "sequenceNumber",
            "run_event_sequence_number" AS "runEventSequenceNumber"
        `,
        [threadId, previousApiRunId],
      );
      assert.equal(previousApiInsert.rows.length, 1);
      assert.deepEqual(
        previousApiInsert.rows.map((row) => {
          return {
            runEventSequenceNumber: row.runEventSequenceNumber,
            sequenceNumber: row.sequenceNumber,
          };
        }),
        [{ runEventSequenceNumber: 7, sequenceNumber: 7 }],
      );

      const currentApiQuery = database
        .insert(chatEvents)
        .values({
          chatThreadId: threadId,
          runId: currentApiRunId,
          eventType: "output.message",
          runEventSequenceNumber: 9,
          seqId: 10003,
        })
        .onConflictDoNothing({
          target: [chatEvents.runId, chatEvents.runEventSequenceNumber],
        })
        .returning({
          sequenceNumber: chatEvents.runEventSequenceNumber,
        });
      const currentApiSql = currentApiQuery.toSQL();
      const currentApiExplanation = await client.query<{
        "QUERY PLAN": unknown;
      }>(`EXPLAIN (FORMAT JSON) ${currentApiSql.sql}`, currentApiSql.params);
      function collectConflictArbiterIndexes(
        value: unknown,
      ): readonly string[] {
        if (Array.isArray(value)) {
          return value.flatMap((item) => {
            return collectConflictArbiterIndexes(item);
          });
        }
        if (typeof value !== "object" || value === null) {
          return [];
        }
        const record = value as Record<string, unknown>;
        const directIndexes = record["Conflict Arbiter Indexes"];
        return [
          ...(Array.isArray(directIndexes)
            ? directIndexes.filter((item): item is string => {
                return typeof item === "string";
              })
            : []),
          ...Object.values(record).flatMap((item) => {
            return collectConflictArbiterIndexes(item);
          }),
        ];
      }
      assert.deepEqual(
        collectConflictArbiterIndexes(
          currentApiExplanation.rows[0]?.["QUERY PLAN"],
        ),
        ["chat_events_run_event_seq_unique"],
      );

      assert.deepEqual(await currentApiQuery, [{ sequenceNumber: 9 }]);
      const mirroredRuntimeWrites = await client.query<{
        legacySequenceNumber: number;
        runEventSequenceNumber: number;
        runId: string;
      }>(
        `
          SELECT
            "run_id" AS "runId",
            "sequence_number" AS "legacySequenceNumber",
            "run_event_sequence_number" AS "runEventSequenceNumber"
          FROM "chat_events"
          WHERE "run_id" IN ($1, $2)
          ORDER BY "run_id"
        `,
        [previousApiRunId, currentApiRunId],
      );
      assert.deepEqual(mirroredRuntimeWrites.rows, [
        {
          legacySequenceNumber: 7,
          runEventSequenceNumber: 7,
          runId: previousApiRunId,
        },
        {
          legacySequenceNumber: 9,
          runEventSequenceNumber: 9,
          runId: currentApiRunId,
        },
      ]);

      const indexes = await client.query<{
        definition: string;
        isUnique: boolean;
        isValid: boolean;
        name: string;
      }>(`
        SELECT
          "index_class"."relname" AS "name",
          "index"."indisunique" AS "isUnique",
          "index"."indisvalid" AS "isValid",
          pg_get_indexdef("index"."indexrelid") AS "definition"
        FROM "pg_index" AS "index"
        INNER JOIN "pg_class" AS "index_class"
          ON "index_class"."oid" = "index"."indexrelid"
        WHERE "index_class"."relname" IN (
          'chat_events_run_seq_unique',
          'chat_events_run_event_seq_unique'
        )
        ORDER BY "index_class"."relname"
      `);
      assert.deepEqual(
        indexes.rows.map((index) => {
          return {
            isUnique: index.isUnique,
            isValid: index.isValid,
            name: index.name,
          };
        }),
        [
          {
            isUnique: true,
            isValid: true,
            name: "chat_events_run_event_seq_unique",
          },
          {
            isUnique: true,
            isValid: true,
            name: "chat_events_run_seq_unique",
          },
        ],
      );
      assert.match(
        indexes.rows[0]?.definition ?? "",
        /\(run_id, run_event_sequence_number\)$/u,
      );
      assert.match(
        indexes.rows[1]?.definition ?? "",
        /\(run_id, sequence_number\)$/u,
      );

      await client.query(`DROP INDEX "chat_events_run_event_seq_unique"`);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 7, 10004)
        `,
        values: [threadId, previousApiRunId],
      });
      await client.query(`
        CREATE UNIQUE INDEX "chat_events_run_event_seq_unique"
        ON "chat_events" USING btree (
          "run_id",
          "run_event_sequence_number"
        )
      `);

      await client.query(`DROP INDEX "chat_events_run_seq_unique"`);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_event_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 9, 10005)
        `,
        values: [threadId, currentApiRunId],
      });
      await client.query(`
        CREATE UNIQUE INDEX "chat_events_run_seq_unique"
        ON "chat_events" USING btree ("run_id", "sequence_number")
      `);

      await expectDatabaseError(client, {
        code: "P0001",
        messageIncludes: "chat event run event sequence columns must match",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, gen_random_uuid(), 'output.message', 1, 2, 10006)
        `,
        values: [threadId],
      });

      const previousApiEventId = previousApiInsert.rows[0]?.id;
      assert.ok(previousApiEventId);
      await assertChatEventsAppendOnlyProtection(client, previousApiEventId);
      await expectDatabaseError(client, {
        code: "P0001",
        messageIncludes: "chat_events is append-only; UPDATE is not allowed",
        query: `
          UPDATE "chat_events"
          SET "run_event_sequence_number" = 10
          WHERE "run_id" = $1
        `,
        values: [currentApiRunId],
      });

      const rejectFunction = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.doesNotMatch(
        rejectFunction.rows[0]?.definition ?? "",
        /run_event_sequence_number/u,
      );
      const strictRejectFunctionDefinition = rejectFunction.rows[0]?.definition;
      assert.ok(strictRejectFunctionDefinition);

      await applyMigrationsUpToTag(
        client,
        RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_MIGRATION,
      );

      const preservedRows = await client.query<{
        maximumSequence: number;
        minimumSequence: number;
        rows: string;
      }>(
        `
          SELECT
            count(*)::text AS "rows",
            min("run_event_sequence_number") AS "minimumSequence",
            max("run_event_sequence_number") AS "maximumSequence"
          FROM "chat_events"
          WHERE "run_id" = $1
        `,
        [historicalRunId],
      );
      assert.deepEqual(preservedRows.rows, [
        {
          maximumSequence: 10001,
          minimumSequence: 1,
          rows: "10001",
        },
      ]);

      const switchedRows = await client.query<{
        runEventSequenceNumber: number;
        runId: string;
      }>(
        `
          SELECT
            "run_id" AS "runId",
            "run_event_sequence_number" AS "runEventSequenceNumber"
          FROM "chat_events"
          WHERE "run_id" IN ($1, $2)
          ORDER BY "run_id"
        `,
        [previousApiRunId, currentApiRunId],
      );
      assert.deepEqual(switchedRows.rows, [
        {
          runEventSequenceNumber: 7,
          runId: previousApiRunId,
        },
        {
          runEventSequenceNumber: 9,
          runId: currentApiRunId,
        },
      ]);

      const contractedInsert = await database
        .insert(chatEvents)
        .values({
          chatThreadId: threadId,
          runId: contractedRunId,
          eventType: "output.message",
          runEventSequenceNumber: 11,
          seqId: 10007,
        })
        .returning({
          id: chatEvents.id,
          sequenceNumber: chatEvents.runEventSequenceNumber,
        });
      assert.equal(contractedInsert.length, 1);
      assert.equal(contractedInsert[0]?.sequenceNumber, 11);
      const contractedEventId = contractedInsert[0]?.id;
      assert.ok(contractedEventId);

      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_event_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 11, 10008)
        `,
        values: [threadId, contractedRunId],
      });
      await assertChatEventsAppendOnlyProtection(client, contractedEventId);

      const contractionStatements = contractionSql
        .split("--> statement-breakpoint")
        .map((statement) => {
          return statement.trim();
        })
        .filter((statement) => {
          return statement.length > 0;
        });
      for (const statement of contractionStatements) {
        await client.query(statement);
      }

      const contractedCatalog = await client.query<{
        backfillProcedurePresent: boolean;
        bridgeFunctionPresent: boolean;
        bridgeTriggerPresent: boolean;
        canonicalIndexValid: boolean;
        legacyColumnPresent: boolean;
        legacyIndexPresent: boolean;
        rejectTriggerEnabled: string;
      }>(`
        SELECT
          EXISTS (
            SELECT 1
            FROM "information_schema"."columns"
            WHERE "table_schema" = 'public'
              AND "table_name" = 'chat_events'
              AND "column_name" = 'sequence_number'
          ) AS "legacyColumnPresent",
          to_regclass('public.chat_events_run_seq_unique') IS NOT NULL
            AS "legacyIndexPresent",
          EXISTS (
            SELECT 1
            FROM "pg_index"
            WHERE "indexrelid" =
              'public.chat_events_run_event_seq_unique'::regclass
              AND "indisunique"
              AND "indisvalid"
          ) AS "canonicalIndexValid",
          to_regprocedure(
            'public.bridge_chat_event_run_event_sequence_number_0807()'
          ) IS NOT NULL AS "bridgeFunctionPresent",
          to_regprocedure(
            'public.backfill_chat_event_run_event_sequence_number_0807()'
          ) IS NOT NULL AS "backfillProcedurePresent",
          EXISTS (
            SELECT 1
            FROM "pg_trigger"
            WHERE "tgrelid" = 'public.chat_events'::regclass
              AND "tgname" =
                'bridge_chat_event_run_event_sequence_number_0807'
              AND NOT "tgisinternal"
          ) AS "bridgeTriggerPresent",
          (
            SELECT "tgenabled"::text
            FROM "pg_trigger"
            WHERE "tgrelid" = 'public.chat_events'::regclass
              AND "tgname" = 'chat_events_reject_update'
              AND NOT "tgisinternal"
          ) AS "rejectTriggerEnabled"
      `);
      assert.deepEqual(contractedCatalog.rows, [
        {
          backfillProcedurePresent: false,
          bridgeFunctionPresent: false,
          bridgeTriggerPresent: false,
          canonicalIndexValid: true,
          legacyColumnPresent: false,
          legacyIndexPresent: false,
          rejectTriggerEnabled: "O",
        },
      ]);

      const preservedRejectFunction = await client.query<{
        definition: string;
      }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.equal(
        preservedRejectFunction.rows[0]?.definition,
        strictRejectFunctionDefinition,
      );
      await assertChatEventsAppendOnlyProtection(client, contractedEventId);

      console.log("   ✅ 10,001 historical rows backfill across batches");
      console.log(
        "   ✅ Draining legacy and current Drizzle inserts coexist with mirrored columns",
      );
      console.log(
        "   ✅ Current targeted ON CONFLICT resolves to chat_events_run_event_seq_unique",
      );
      console.log("   ✅ Both unique index paths reject duplicates with 23505");
      console.log("   ✅ Strict append-only protection is restored");
      console.log(
        "   ✅ Contract preserves canonical rows and new writes while the canonical index independently rejects duplicates",
      );
      console.log(
        "   ✅ Legacy column, index, bridge, and backfill procedure are absent",
      );
      console.log(
        "   ✅ Contraction non-transactional retries are idempotent\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const GOAL_ONLY_RUN_GROUPS_PREVIOUS_MIGRATION = "0810_small_sway";
const GOAL_ONLY_RUN_GROUPS_MIGRATION = "0811_clear_non_goal_run_groups";

async function validateGoalOnlyRunGroupsCleanup(): Promise<void> {
  console.log("=== Validate goal-only run group cleanup ===\n");
  const testDb = "migration_goal_only_run_groups_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000081001",
    sessionId: "00000000-0000-4000-8000-000000081002",
    threadId: "00000000-0000-4000-8000-000000081003",
    goalId: "00000000-0000-4000-8000-000000081004",
    automationGroupId: "00000000-0000-4000-8000-000000081005",
    workflowRunId: "00000000-0000-4000-8000-000000081006",
    goalRunId: "00000000-0000-4000-8000-000000081007",
    automationEventId: "00000000-0000-4000-8000-000000081008",
    goalEventId: "00000000-0000-4000-8000-000000081009",
    drainingWorkflowRunId: "00000000-0000-4000-8000-000000081010",
    drainingAutomationEventId: "00000000-0000-4000-8000-000000081011",
    orgId: "goal-only-run-groups-org",
    userId: "goal-only-run-groups-user",
  } as const;

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0811_clear_non_goal_run_groups.sql"),
    "utf8",
  );
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/u);
  assert.doesNotMatch(
    migrationSql,
    /(?:DROP|DISABLE)\s+TRIGGER\s+"chat_events_reject_update"/u,
  );
  assert.equal((migrationSql.match(/\bLIMIT 10000\b/gu) ?? []).length, 2);
  assert.equal(
    (migrationSql.match(/\bFOR UPDATE OF "candidate" SKIP LOCKED\b/gu) ?? [])
      .length,
    2,
  );
  assert.equal((migrationSql.match(/\bCOMMIT\b/gu) ?? []).length, 2);

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      GOAL_ONLY_RUN_GROUPS_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, $2, 'goal-only-run-groups', $3)
        `,
        [fixture.composeId, fixture.userId, fixture.orgId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, $2, $3, 'goal-only-run-groups')
        `,
        [fixture.composeId, fixture.orgId, fixture.userId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" (
            "id",
            "user_id",
            "org_id",
            "agent_compose_id"
          )
          VALUES ($1, $2, $3, $4)
        `,
        [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id",
            "user_id",
            "session_id",
            "status",
            "prompt",
            "org_id"
          )
          VALUES
            ($1, $3, $4, 'running', 'legacy workflow run', $5),
            ($2, $3, $4, 'running', 'goal continuation run', $5)
        `,
        [
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.userId,
          fixture.sessionId,
          fixture.orgId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "title"
          )
          VALUES ($1, $2, $3, 'goal-only run groups')
        `,
        [fixture.threadId, fixture.userId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id",
            "org_id",
            "owner_user_id",
            "agent_id",
            "chat_thread_id",
            "status",
            "objective",
            "objective_brief"
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'active',
            'Keep this goal running',
            'Keep this goal running'
          )
        `,
        [
          fixture.goalId,
          fixture.orgId,
          fixture.userId,
          fixture.composeId,
          fixture.threadId,
        ],
      );
      await client.query(
        `
          INSERT INTO "zero_runs" (
            "id",
            "trigger_source",
            "chat_thread_id",
            "run_group_id",
            "goal_id"
          )
          VALUES
            ($1, 'automation-schedule', $3, $4, NULL),
            ($2, 'goal', $3, $5, $5)
        `,
        [
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.threadId,
          fixture.automationGroupId,
          fixture.goalId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "content",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES
            ($1, $3, $4, $6, 'output.message', 'workflow result', 1, 1),
            ($2, $3, $5, $7, 'output.message', 'goal result', 1, 2)
        `,
        [
          fixture.automationEventId,
          fixture.goalEventId,
          fixture.threadId,
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.automationGroupId,
          fixture.goalId,
        ],
      );

      await applyMigrationsUpToTag(client, GOAL_ONLY_RUN_GROUPS_MIGRATION);

      const runGroups = await client.query<{
        id: string;
        runGroupId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId"
          FROM "zero_runs"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [fixture.workflowRunId, fixture.goalRunId],
      );
      assert.deepEqual(runGroups.rows, [
        { id: fixture.workflowRunId, runGroupId: null },
        { id: fixture.goalRunId, runGroupId: fixture.goalId },
      ]);

      const eventGroups = await client.query<{
        id: string;
        runGroupId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [fixture.automationEventId, fixture.goalEventId],
      );
      assert.deepEqual(eventGroups.rows, [
        { id: fixture.automationEventId, runGroupId: null },
        { id: fixture.goalEventId, runGroupId: fixture.goalId },
      ]);

      // Simulate the draining API after migration completion. Its legacy
      // insert shape still sends the automation id as run_group_id to both
      // tables; the compatibility bridges must normalize both writes.
      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id",
            "user_id",
            "session_id",
            "status",
            "prompt",
            "org_id"
          )
          VALUES ($1, $2, $3, 'running', 'draining workflow run', $4)
        `,
        [
          fixture.drainingWorkflowRunId,
          fixture.userId,
          fixture.sessionId,
          fixture.orgId,
        ],
      );
      await client.query(
        `
          INSERT INTO "zero_runs" (
            "id",
            "trigger_source",
            "chat_thread_id",
            "run_group_id",
            "goal_id"
          )
          VALUES ($1, 'automation-event', $2, $3, NULL)
        `,
        [
          fixture.drainingWorkflowRunId,
          fixture.threadId,
          fixture.automationGroupId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "content",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'output.message', 'draining result', 1, 3)
        `,
        [
          fixture.drainingAutomationEventId,
          fixture.threadId,
          fixture.drainingWorkflowRunId,
          fixture.automationGroupId,
        ],
      );

      const drainingGroups = await client.query<{
        eventRunGroupId: string | null;
        zeroRunGroupId: string | null;
      }>(
        `
          SELECT
            "event"."run_group_id" AS "eventRunGroupId",
            "run"."run_group_id" AS "zeroRunGroupId"
          FROM "zero_runs" AS "run"
          INNER JOIN "chat_events" AS "event"
            ON "event"."run_id" = "run"."id"
          WHERE "run"."id" = $1
        `,
        [fixture.drainingWorkflowRunId],
      );
      assert.deepEqual(drainingGroups.rows, [
        { eventRunGroupId: null, zeroRunGroupId: null },
      ]);

      const migrationStatements = migrationSql
        .split("--> statement-breakpoint")
        .map((statement) => {
          return statement.trim();
        })
        .filter((statement) => {
          return statement.length > 0;
        });
      for (const statement of migrationStatements) {
        await client.query(statement);
      }

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.automationEventId,
      );
      const rejectFunction = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.doesNotMatch(
        rejectFunction.rows[0]?.definition ?? "",
        /run_group_id/u,
      );

      console.log("   ✅ Legacy workflow run groups are cleared");
      console.log("   ✅ Goal continuation run groups are preserved");
      console.log("   ✅ Draining automation writes are normalized");
      console.log(
        "   ✅ Cleanup is batched, retryable, and append-only safe\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateTeamsMessageFileScopeBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.4: Validate Teams message file scope backfill ===\n",
  );
  const testDb = "migration_teams_message_file_scope_test";
  await createDatabase(testDb);
  const testDbUrl = createTestDbUrl(testDb);

  try {
    await runMigrationsUpToTag(testDbUrl, "0815_clammy_wendigo");
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    try {
      const composeId = "00000000-0000-4000-8000-000000081301";
      const threadId = "00000000-0000-4000-8000-000000081302";
      const contextId = "00000000-0000-4000-8000-000000081303";
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'teams-file-scope-user', 'teams-file-scope', 'teams-file-scope-org')
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "last_chat_event_seq_id"
          )
          VALUES ($1, 'teams-file-scope-user', $2, 1)
        `,
        [threadId, composeId],
      );

      const legacyMessageFiles = [
        {
          fileId: "teams-current-file",
          sourceId: "current-source",
          name: "current.txt",
          contentType: "text/plain",
          payload: {
            tenantId: "teams-file-scope-tenant",
            url: "https://files.example.test/current.txt",
          },
        },
        {
          fileId: "teams-context-file",
          sourceId: "context-source",
          name: "context.txt",
          contentType: "text/plain",
          payload: {
            tenantId: "teams-file-scope-tenant",
            url: "https://files.example.test/context.txt",
          },
        },
      ];
      await client.query(
        `
          INSERT INTO "chat_teams_context" (
            "id",
            "chat_thread_id",
            "tenant_id",
            "conversation_id",
            "message_files"
          )
          VALUES ($1, $2, 'teams-file-scope-tenant', 'teams-file-scope-conversation', $3::jsonb)
        `,
        [contextId, threadId, JSON.stringify(legacyMessageFiles)],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "event_type",
            "context_type",
            "context_id",
            "trigger_source",
            "user_message",
            "seq_id"
          )
          VALUES ($1, 'input.prompt', 'teams', $2, 'teams', $3::jsonb, 1)
        `,
        [
          threadId,
          contextId,
          JSON.stringify({
            version: 1,
            parts: [
              {
                type: "file",
                fileId: "teams-current-file",
                filenameSnapshot: "current.txt",
                contentType: "text/plain",
              },
              { type: "text", text: "legacy Teams file scope" },
            ],
          }),
        ],
      );

      await applyMigrationsUpToTag(
        client,
        "0816_backfill_teams_message_file_scope",
      );

      const result = await client.query<{ messageFiles: unknown }>(
        `
          SELECT "message_files" AS "messageFiles"
          FROM "chat_teams_context"
          WHERE "id" = $1
        `,
        [contextId],
      );
      assert.deepEqual(result.rows[0]?.messageFiles, [
        { ...legacyMessageFiles[0], inCurrentMessage: true },
        { ...legacyMessageFiles[1], inCurrentMessage: false },
      ]);
      console.log(
        "   ✅ Legacy Teams message files receive exact scope flags\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const INVALIDATED_GOAL_CONTINUATION_PREVIOUS_MIGRATION =
  "0828_migrate_legacy_deepseek_state";
const INVALIDATED_GOAL_CONTINUATION_MIGRATION =
  "0829_revoke_invalidated_goal_continuations";

async function validateInvalidatedGoalContinuationCleanup(): Promise<void> {
  console.log("=== Validate invalidated goal continuation cleanup ===\n");
  const testDb = "migration_invalidated_goal_continuation_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000082801",
    threadId: "00000000-0000-4000-8000-000000082802",
    queuedGoalId: "00000000-0000-4000-8000-000000082803",
    rejectedGoalId: "00000000-0000-4000-8000-000000082804",
    drainingQueuedGoalId: "00000000-0000-4000-8000-000000082805",
    drainingRejectedGoalId: "00000000-0000-4000-8000-000000082806",
    failedQueuedGoalId: "00000000-0000-4000-8000-000000082807",
    failedRejectedGoalId: "00000000-0000-4000-8000-000000082808",
  } as const;
  const invalidationError =
    "Goal continuation no longer matches the active goal";
  const goalMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "goal", goalBrief: "migration fixture" }],
  });

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      INVALIDATED_GOAL_CONTINUATION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'goal-invalidation-user', 'goal-invalidation', 'goal-invalidation-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "last_chat_event_seq_id"
          )
          VALUES ($1, 'goal-invalidation-user', $2, 2)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES
            ($1, $3, NULL, 'input.goal', NULL, $5::jsonb, 1),
            ($2, $3, $1, 'input.rejected', $4, $5::jsonb, 2)
        `,
        [
          fixture.queuedGoalId,
          fixture.rejectedGoalId,
          fixture.threadId,
          invalidationError,
          goalMessage,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        INVALIDATED_GOAL_CONTINUATION_MIGRATION,
      );

      const backfilled = await client.query<{
        eventType: string;
        seqId: number;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "seq_id"::int AS "seqId"
          FROM "chat_events"
          WHERE "revokes_event_id" = $1
        `,
        [fixture.rejectedGoalId],
      );
      assert.deepEqual(backfilled.rows, [
        { eventType: "control.revoke", seqId: 3 },
      ]);
      const legacyRejected = await client.query<{
        error: string | null;
        eventType: string;
      }>(
        `
          SELECT "event_type" AS "eventType", "error"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.rejectedGoalId],
      );
      assert.deepEqual(legacyRejected.rows, [
        { eventType: "input.rejected", error: invalidationError },
      ]);
      const thread = await client.query<{ lastSeqId: number }>(
        `
          SELECT "last_chat_event_seq_id"::int AS "lastSeqId"
          FROM "chat_threads"
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      assert.deepEqual(thread.rows, [{ lastSeqId: 3 }]);

      await client.query(
        `
          UPDATE "chat_threads"
          SET "last_chat_event_seq_id" = 5
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, 'input.goal', $3::jsonb, 4)
        `,
        [fixture.drainingQueuedGoalId, fixture.threadId, goalMessage],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, $3, 'input.rejected', $4, $5::jsonb, 5)
        `,
        [
          fixture.drainingRejectedGoalId,
          fixture.threadId,
          fixture.drainingQueuedGoalId,
          invalidationError,
          goalMessage,
        ],
      );
      await client.query(
        `
          UPDATE "chat_threads"
          SET "last_chat_event_seq_id" = 7
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, 'input.goal', $3::jsonb, 6)
        `,
        [fixture.failedQueuedGoalId, fixture.threadId, goalMessage],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES (
            $1,
            $2,
            $3,
            'input.rejected',
            'run creation failed',
            $4::jsonb,
            7
          )
        `,
        [
          fixture.failedRejectedGoalId,
          fixture.threadId,
          fixture.failedQueuedGoalId,
          goalMessage,
        ],
      );

      const drainingWrite = await client.query<{
        error: string | null;
        eventType: string;
        userMessage: unknown;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "error",
            "user_message" AS "userMessage"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.drainingRejectedGoalId],
      );
      assert.deepEqual(drainingWrite.rows, [
        { eventType: "control.revoke", error: null, userMessage: null },
      ]);
      const failedWrite = await client.query<{
        error: string | null;
        eventType: string;
        userMessage: unknown;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "error",
            "user_message" AS "userMessage"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.failedRejectedGoalId],
      );
      assert.deepEqual(failedWrite.rows, [
        {
          eventType: "input.rejected",
          error: "run creation failed",
          userMessage: JSON.parse(goalMessage),
        },
      ]);

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.rejectedGoalId,
      );
      console.log("   ✅ Legacy invalidations receive append-only tombstones");
      console.log("   ✅ Draining API invalidations are normalized on insert");
      console.log("   ✅ Real goal continuation failures remain rejected\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACT_CUTOVER_PREVIOUS_MIGRATION =
  "0860_striped_shadow_king";
const CHAT_EVENT_CONTRACT_CUTOVER_MIGRATION =
  "0861_chat_event_contract_cutover";

async function validateChatEventContractCutover(): Promise<void> {
  console.log("=== Validate chat-event contract atomic cutover ===\n");
  const testDb = "migration_chat_event_contract_cutover_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086101",
    activeThreadId: "00000000-0000-4000-8000-000000086102",
    pausedThreadId: "00000000-0000-4000-8000-000000086103",
    activeGoalId: "00000000-0000-4000-8000-000000086104",
    pausedGoalId: "00000000-0000-4000-8000-000000086105",
    legacyActiveMarkerId: "00000000-0000-4000-8000-000000086106",
    legacyMarkerRevokerId: "00000000-0000-4000-8000-000000086107",
    unrelatedEventId: "00000000-0000-4000-8000-000000086108",
    followupsEventId: "00000000-0000-4000-8000-000000086109",
    followupsRevokerId: "00000000-0000-4000-8000-000000086110",
    legacyPausedMarkerId: "00000000-0000-4000-8000-000000086111",
    historicalRunId: "00000000-0000-4000-8000-000000086112",
  } as const;
  const historicalFollowups = [
    {
      prompt: "Generate a launch page",
      kind: "generate",
      generationType: "website",
    },
    { prompt: "Summarize the result", kind: "talk" },
  ] as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACT_CUTOVER_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'contract-cutover-user', 'contract-cutover', 'contract-cutover-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'contract-cutover-org',
            'contract-cutover-user',
            'contract-cutover',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES
            ($2, 'contract-cutover-user', $1, 5),
            ($3, 'contract-cutover-user', $1, 1)
        `,
        [fixture.composeId, fixture.activeThreadId, fixture.pausedThreadId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id",
            "org_id",
            "owner_user_id",
            "agent_id",
            "chat_thread_id",
            "status",
            "objective",
            "objective_brief"
          ) VALUES
            (
              $4,
              'contract-cutover-org',
              'contract-cutover-user',
              $1,
              $2,
              'active',
              'Current active objective details',
              '  Current active objective  '
            ),
            (
              $5,
              'contract-cutover-org',
              'contract-cutover-user',
              $1,
              $3,
              'paused',
              'Paused objective details',
              'Paused objective'
            )
        `,
        [
          fixture.composeId,
          fixture.activeThreadId,
          fixture.pausedThreadId,
          fixture.activeGoalId,
          fixture.pausedGoalId,
        ],
      );

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "revokes_event_id",
            "event_type",
            "context_type",
            "content",
            "user_message",
            "run_event_sequence_number",
            "run_event_id",
            "goal_event",
            "recommended_followups",
            "seq_id",
            "created_at"
          ) VALUES
            (
              $1, $7, NULL, NULL, NULL, 'goal.changed', NULL, NULL, NULL, NULL, NULL,
              '{"type":"state","status":"active","objectiveBrief":"Historical objective"}'::jsonb,
              NULL, 1, '2026-08-01 12:00:01'
            ),
            (
              $2, $7, NULL, NULL, $1, 'control.revoke', NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, 2, '2026-08-01 12:00:02'
            ),
            (
              $3, $7, NULL, NULL, NULL, 'output.message', NULL, 'Unrelated output', NULL,
              NULL, NULL, NULL, NULL, 3, '2026-08-01 12:00:03'
            ),
            (
              $4, $7, $6, $11, NULL, 'output.followups', NULL, NULL, NULL, 17,
              'followups:historical', NULL, $9::jsonb, 4,
              '2026-08-01 12:00:04'
            ),
            (
              $5, $7, NULL, NULL, $4, 'input.prompt', 'web', NULL,
              '{"version":1,"parts":[{"type":"text","text":"Use the followup"}]}'::jsonb,
              NULL, NULL, NULL, NULL, 5, '2026-08-01 12:00:05'
            ),
            (
              $8, $10, NULL, NULL, NULL, 'goal.changed', NULL, NULL, NULL, NULL, NULL,
              '{"type":"state","status":"paused"}'::jsonb,
              NULL, 1, '2026-08-01 12:00:06'
            )
        `,
        [
          fixture.legacyActiveMarkerId,
          fixture.legacyMarkerRevokerId,
          fixture.unrelatedEventId,
          fixture.followupsEventId,
          fixture.followupsRevokerId,
          fixture.historicalRunId,
          fixture.activeThreadId,
          fixture.legacyPausedMarkerId,
          JSON.stringify(historicalFollowups),
          fixture.pausedThreadId,
          fixture.activeGoalId,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACT_CUTOVER_MIGRATION,
      );

      const activeMarkers = await client.query<{
        content: string;
        eventType: string;
        seqId: number;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "content",
            "seq_id"::int AS "seqId"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
            AND "event_type" IN ('goal.open', 'goal.close')
          ORDER BY "seq_id"
        `,
        [fixture.activeThreadId],
      );
      assert.deepEqual(activeMarkers.rows, [
        {
          eventType: "goal.open",
          content: "Current active objective",
          seqId: 6,
        },
      ]);
      const pausedMarkers = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS "count"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
            AND "event_type" IN ('goal.open', 'goal.close')
        `,
        [fixture.pausedThreadId],
      );
      assert.deepEqual(pausedMarkers.rows, [{ count: 0 }]);

      const deletedGoalHistory = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS "count"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3)
        `,
        [
          fixture.legacyActiveMarkerId,
          fixture.legacyMarkerRevokerId,
          fixture.legacyPausedMarkerId,
        ],
      );
      assert.deepEqual(deletedGoalHistory.rows, [{ count: 0 }]);
      const unrelated = await client.query<{ content: string }>(
        `SELECT "content" FROM "chat_events" WHERE "id" = $1`,
        [fixture.unrelatedEventId],
      );
      assert.deepEqual(unrelated.rows, [{ content: "Unrelated output" }]);

      const migratedFollowups = await client.query<{
        content: string;
        createdAt: string;
        id: string;
        recommendedFollowups: unknown;
        runEventId: string;
        runEventSequenceNumber: number;
        runGroupId: string;
        runId: string;
        seqId: number;
        threadId: string;
      }>(
        `
          SELECT
            "id",
            "chat_thread_id" AS "threadId",
            "run_id" AS "runId",
            "run_group_id" AS "runGroupId",
            "content",
            "recommended_followups" AS "recommendedFollowups",
            "run_event_sequence_number" AS "runEventSequenceNumber",
            "run_event_id" AS "runEventId",
            "seq_id"::int AS "seqId",
            to_char("created_at", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.followupsEventId],
      );
      assert.equal(migratedFollowups.rows.length, 1);
      const migratedFollowup = migratedFollowups.rows[0]!;
      assert.deepEqual(
        {
          ...migratedFollowup,
          content: JSON.parse(migratedFollowup.content),
        },
        {
          id: fixture.followupsEventId,
          threadId: fixture.activeThreadId,
          runId: fixture.historicalRunId,
          runGroupId: fixture.activeGoalId,
          content: { version: 1, followups: historicalFollowups },
          recommendedFollowups: null,
          runEventSequenceNumber: 17,
          runEventId: "followups:historical",
          seqId: 4,
          createdAt: "2026-08-01 12:00:04",
        },
      );
      const preservedRevocation = await client.query<{
        revokesEventId: string;
      }>(
        `SELECT "revokes_event_id" AS "revokesEventId" FROM "chat_events" WHERE "id" = $1`,
        [fixture.followupsRevokerId],
      );
      assert.deepEqual(preservedRevocation.rows, [
        { revokesEventId: fixture.followupsEventId },
      ]);

      const eventTypeConstraint = await client.query<{ definition: string }>(`
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `);
      assert.doesNotMatch(
        eventTypeConstraint.rows[0]?.definition ?? "",
        /goal\.changed/u,
      );
      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.followupsEventId,
      );
      console.log("   ✅ active goals received one fresh canonical marker");
      console.log(
        "   ✅ historical goal markers and dependent revokes were deleted",
      );
      console.log("   ✅ followups migrated in place without identity loss");
      console.log("   ✅ the historical cutover constraint is canonical\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACTION_PREPARE_PREVIOUS_MIGRATION =
  "0862_first_pepper_potts";
const CHAT_EVENT_CONTRACTION_PREPARE_MIGRATION =
  "0863_prepare_chat_event_contraction";

async function validateChatEventContractionPreparation(): Promise<void> {
  console.log("=== Validate chat-event contraction preparation ===\n");
  const testDb = "migration_chat_event_contraction_prepare_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086301",
    threadId: "00000000-0000-4000-8000-000000086302",
    startedId: "00000000-0000-4000-8000-000000086303",
    stoppedId: "00000000-0000-4000-8000-000000086304",
    openId: "00000000-0000-4000-8000-000000086305",
    closeId: "00000000-0000-4000-8000-000000086306",
    payloadId: "00000000-0000-4000-8000-000000086307",
    canonicalOpenId: "00000000-0000-4000-8000-000000086308",
    canonicalCloseId: "00000000-0000-4000-8000-000000086309",
    goalOpenId: "00000000-0000-4000-8000-000000086310",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACTION_PREPARE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'final-contract-user', 'final-contract', 'final-contract-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'final-contract-org',
            'final-contract-user',
            'final-contract',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES ($1, 'final-contract-user', $2, 5)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "active_input_sequence",
            "goal_event",
            "attach_files",
            "generation_template",
            "recommended_followups",
            "seq_id"
          ) VALUES
            ($1, $6, 'browser.started', NULL, NULL, NULL, NULL, NULL, 1),
            ($2, $6, 'browser.stopped', NULL, NULL, NULL, NULL, NULL, 2),
            ($3, $6, 'browser.open', NULL, NULL, NULL, NULL, NULL, 3),
            ($4, $6, 'browser.close', NULL, NULL, NULL, NULL, NULL, 4),
            (
              $5,
              $6,
              'output.message',
              7,
              '{"retired":true}'::jsonb,
              '[]'::jsonb,
              '{"retired":true}'::jsonb,
              '[]'::jsonb,
              5
            )
        `,
        [
          fixture.startedId,
          fixture.stoppedId,
          fixture.openId,
          fixture.closeId,
          fixture.payloadId,
          fixture.threadId,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACTION_PREPARE_MIGRATION,
      );

      const browserEvents = await client.query<{
        eventType: string;
        id: string;
      }>(
        `
          SELECT "id", "event_type" AS "eventType"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3, $4)
          ORDER BY "seq_id"
        `,
        [fixture.startedId, fixture.stoppedId, fixture.openId, fixture.closeId],
      );
      assert.deepEqual(browserEvents.rows, [
        { id: fixture.startedId, eventType: "browser.open" },
        { id: fixture.stoppedId, eventType: "browser.close" },
        { id: fixture.openId, eventType: "browser.open" },
        { id: fixture.closeId, eventType: "browser.close" },
      ]);

      const retainedColumns = await client.query<{ columnName: string }>(`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_events'
          AND "column_name" IN (
            'active_input_sequence',
            'goal_event',
            'attach_files',
            'generation_template',
            'recommended_followups'
          )
        ORDER BY "column_name"
      `);
      assert.deepEqual(retainedColumns.rows, [
        { columnName: "active_input_sequence" },
        { columnName: "attach_files" },
        { columnName: "generation_template" },
        { columnName: "goal_event" },
        { columnName: "recommended_followups" },
      ]);

      // Migration 0863 runs before the Phase 7A API is promoted. Exercise the
      // exact outgoing full-row column set so the currently deployed API stays
      // legal throughout that overlap.
      const outgoingRows = await client.query<{
        row: Record<string, unknown>;
      }>(
        `
          SELECT to_jsonb("outgoing_row") AS "row"
          FROM (
            SELECT
              "id",
              "chat_thread_id",
              "run_id",
              "usage_payload",
              "revokes_event_id",
              "interrupts_run_id",
              "run_group_id",
              "event_type",
              "context_type",
              "context_id",
              "content",
              "user_message",
              "thinking",
              "error",
              "active_input_sequence",
              "run_event_sequence_number",
              "run_event_id",
              "seq_id",
              "goal_event",
              "attach_files",
              "generation_template",
              "recommended_followups",
              "created_at"
            FROM "chat_events"
            WHERE "id" = $1
          ) AS "outgoing_row"
        `,
        [fixture.payloadId],
      );
      const outgoingRow = outgoingRows.rows[0]?.row;
      assert.ok(outgoingRow);
      assert.deepEqual(Object.keys(outgoingRow).sort(), [
        "active_input_sequence",
        "attach_files",
        "chat_thread_id",
        "content",
        "context_id",
        "context_type",
        "created_at",
        "error",
        "event_type",
        "generation_template",
        "goal_event",
        "id",
        "interrupts_run_id",
        "recommended_followups",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_group_id",
        "run_id",
        "seq_id",
        "thinking",
        "usage_payload",
        "user_message",
      ]);
      assert.equal(outgoingRow.active_input_sequence, 7);
      assert.deepEqual(outgoingRow.goal_event, { retired: true });
      assert.deepEqual(outgoingRow.attach_files, []);
      assert.deepEqual(outgoingRow.generation_template, { retired: true });
      assert.deepEqual(outgoingRow.recommended_followups, []);

      const compatibilityObjects = await client.query<{
        functionCount: number;
        indexCount: number;
        triggerCount: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM "pg_proc"
            WHERE "proname" IN (
              'canonicalize_legacy_chat_event_insert_0861',
              'is_supported_legacy_followups_0861'
            )
          ) AS "functionCount",
          (
            SELECT count(*)::int
            FROM "pg_indexes"
            WHERE "schemaname" = 'public'
              AND "indexname" = 'chat_events_run_active_input_seq_unique'
          ) AS "indexCount",
          (
            SELECT count(*)::int
            FROM "pg_trigger"
            WHERE "tgname" = 'canonicalize_legacy_chat_event_insert_0861'
              AND NOT "tgisinternal"
          ) AS "triggerCount"
      `);
      assert.deepEqual(compatibilityObjects.rows, [
        { functionCount: 0, indexCount: 1, triggerCount: 0 },
      ]);

      const eventTypeConstraint = await client.query<{ definition: string }>(`
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `);
      const eventTypeDefinition = eventTypeConstraint.rows[0]?.definition ?? "";
      assert.match(eventTypeDefinition, /browser\.open/u);
      assert.match(eventTypeDefinition, /browser\.close/u);
      assert.doesNotMatch(eventTypeDefinition, /browser\.started/u);
      assert.doesNotMatch(eventTypeDefinition, /browser\.stopped/u);

      const canonicalBrowserRows = await client.query<{ eventType: string }>(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "seq_id"
          ) VALUES
            ($1, $3, 'browser.open', 6),
            ($2, $3, 'browser.close', 7)
          RETURNING "event_type" AS "eventType"
        `,
        [fixture.canonicalOpenId, fixture.canonicalCloseId, fixture.threadId],
      );
      assert.deepEqual(canonicalBrowserRows.rows, [
        { eventType: "browser.open" },
        { eventType: "browser.close" },
      ]);

      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "seq_id"
            ) VALUES ($1, 'browser.started', 8)
          `,
          [fixture.threadId],
        ),
        /chat_events_event_type_check/u,
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "content", "seq_id"
          ) VALUES ($1, $2, 'goal.open', 'Canonical objective', 9)
        `,
        [fixture.goalOpenId, fixture.threadId],
      );
      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "content", "error", "seq_id"
            ) VALUES ($1, 'goal.open', 'Invalid marker', 'payload', 10)
          `,
          [fixture.threadId],
        ),
        /chat_events_goal_marker_payload_check/u,
      );
      await assertChatEventsAppendOnlyProtection(client, fixture.startedId);

      console.log("   ✅ retired browser lifecycle rows are canonicalized");
      console.log("   ✅ only browser.open and browser.close remain allowed");
      console.log("   ✅ the drained 0861 insert bridge is absent");
      console.log(
        "   ✅ outgoing ORM columns and active-input index remain compatible",
      );
      console.log("   ✅ strict append-only and goal marker checks remain\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACTION_FINALIZE_PREVIOUS_MIGRATION =
  "0863_prepare_chat_event_contraction";
const CHAT_EVENT_CONTRACTION_FINALIZE_MIGRATION =
  "0864_finalize_chat_event_contraction";

async function validateChatEventContractionFinalization(): Promise<void> {
  console.log("=== Validate final chat-event contraction ===\n");
  const testDb = "migration_chat_event_contraction_finalize_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086401",
    threadId: "00000000-0000-4000-8000-000000086402",
    retainedEventId: "00000000-0000-4000-8000-000000086403",
    canonicalGoalId: "00000000-0000-4000-8000-000000086404",
    currentInsertId: "00000000-0000-4000-8000-000000086405",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACTION_FINALIZE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'finalize-contract-user', 'finalize-contract', 'finalize-contract-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'finalize-contract-org',
            'finalize-contract-user',
            'finalize-contract',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES ($1, 'finalize-contract-user', $2, 4)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "content",
            "active_input_sequence",
            "goal_event",
            "attach_files",
            "generation_template",
            "recommended_followups",
            "seq_id"
          ) VALUES (
            $1,
            $2,
            'output.message',
            'Canonical output survives',
            7,
            '{"retired":true}'::jsonb,
            '[]'::jsonb,
            '{"retired":true}'::jsonb,
            '[]'::jsonb,
            1
          )
        `,
        [fixture.retainedEventId, fixture.threadId],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACTION_FINALIZE_MIGRATION,
      );

      const retainedRows = await client.query<{
        row: Record<string, unknown>;
      }>(
        `
          SELECT to_jsonb("event") AS "row"
          FROM "chat_events" AS "event"
          WHERE "id" = $1
        `,
        [fixture.retainedEventId],
      );
      const retainedRow = retainedRows.rows[0]?.row;
      assert.ok(retainedRow);
      assert.equal(retainedRow.content, "Canonical output survives");
      assert.deepEqual(Object.keys(retainedRow).sort(), [
        "chat_thread_id",
        "content",
        "context_id",
        "context_type",
        "created_at",
        "error",
        "event_type",
        "id",
        "interrupts_run_id",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_group_id",
        "run_id",
        "seq_id",
        "thinking",
        "usage_payload",
        "user_message",
      ]);

      const finalCatalog = await client.query<{
        columnNames: string[];
        retiredIndex: string | null;
      }>(`
        SELECT
          to_jsonb(ARRAY(
            SELECT "column_name"
            FROM "information_schema"."columns"
            WHERE "table_schema" = 'public'
              AND "table_name" = 'chat_events'
            ORDER BY "column_name"
          )) AS "columnNames",
          to_regclass(
            'public.chat_events_run_active_input_seq_unique'
          )::text AS "retiredIndex"
      `);
      assert.deepEqual(finalCatalog.rows, [
        {
          columnNames: [
            "chat_thread_id",
            "content",
            "context_id",
            "context_type",
            "created_at",
            "error",
            "event_type",
            "id",
            "interrupts_run_id",
            "revokes_event_id",
            "run_event_id",
            "run_event_sequence_number",
            "run_group_id",
            "run_id",
            "seq_id",
            "thinking",
            "usage_payload",
            "user_message",
          ],
          retiredIndex: null,
        },
      ]);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "content", "seq_id"
          ) VALUES ($1, $2, 'goal.open', 'Canonical objective', 2)
        `,
        [fixture.canonicalGoalId, fixture.threadId],
      );
      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "content", "error", "seq_id"
            ) VALUES ($1, 'goal.open', 'Invalid objective', 'payload', 3)
          `,
          [fixture.threadId],
        ),
        /chat_events_goal_marker_payload_check/u,
      );

      await addCurrentChatEventPayloadStorage(client);
      const database = drizzle(client);
      const currentInsert = database
        .insert(chatEvents)
        .values({
          id: fixture.currentInsertId,
          chatThreadId: fixture.threadId,
          eventType: "output.message",
          payload: { content: "Current ORM insert" },
          seqId: 4,
        })
        .returning({ id: chatEvents.id });
      const currentInsertSql = currentInsert.toSQL();
      assert.doesNotMatch(
        currentInsertSql.sql,
        /content|user_message|thinking|error|usage_payload|interrupts_run_id|run_group_id|active_input_sequence|goal_event|attach_files|generation_template|recommended_followups/u,
      );
      assert.match(currentInsertSql.sql, /"payload"/u);
      assert.deepEqual(await currentInsert, [{ id: fixture.currentInsertId }]);
      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.retainedEventId,
      );

      console.log("   ✅ retired chat-event columns and index are absent");
      console.log("   ✅ canonical rows and goal-marker checks survive");
      console.log("   ✅ current ORM inserts use only the final column set\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateFeishuConnectorOwnershipCleanup(): Promise<void> {
  console.log("=== Validate Feishu connector ownership cleanup ===\n");

  const testDb = "migration_feishu_connector_ownership_cleanup_test";
  await createDatabase(testDb);
  const dbUrl = createTestDbUrl(testDb);

  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();

    try {
      await applyMigrationsUpToTag(
        client,
        "0939_backfill_feishu_custom_connector_ownership",
      );

      const orgId = "org_feishu_ownership_cleanup";
      const userId = "user_feishu_ownership_cleanup";
      const composeId = "00000000-0000-4000-8000-000000094001";
      const matchedInstallationId = "00000000-0000-4000-8000-000000094002";
      const matchedConnectorId = "00000000-0000-4000-8000-000000094003";
      const mismatchedInstallationId = "00000000-0000-4000-8000-000000094004";
      const mismatchedConnectorId = "00000000-0000-4000-8000-000000094005";
      const orphanConnectorId = "00000000-0000-4000-8000-000000094006";
      const orphanSlugId = "00000000-0000-4000-8000-000000094007";
      const unrelatedConnectorId = "00000000-0000-4000-8000-000000094008";
      const unrelatedSlugId = "00000000-0000-4000-8000-000000094009";

      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, $2, 'feishu-ownership-cleanup', $3)
        `,
        [composeId, userId, orgId],
      );
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO "org_custom_connectors" (
            "id",
            "org_id",
            "slug",
            "display_name",
            "prefix_templates",
            "fields",
            "header_injections",
            "query_injections",
            "auth_mode",
            "created_by"
          ) VALUES
            (
              $1,
              $2,
              '_feishu-' || $3::text,
              'Matched Feishu connector',
              '["https://open.feishu.cn/open-apis/"]'::jsonb,
              '[]'::jsonb,
              '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
              '[]'::jsonb,
              'oauth',
              $4
            ),
            (
              $5,
              $2,
              '_feishu-' || $6::text,
              'Mismatched Feishu connector',
              '["https://open.feishu.cn/open-apis/"]'::jsonb,
              '[]'::jsonb,
              '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
              '[]'::jsonb,
              'oauth',
              $4
            ),
            (
              $7,
              $2,
              '_feishu-' || $8::text,
              'Orphaned Feishu connector',
              '["https://open.feishu.cn/open-apis/"]'::jsonb,
              '[]'::jsonb,
              '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
              '[]'::jsonb,
              'oauth',
              $4
            ),
            (
              $9,
              $2,
              '_feishu-' || $10::text,
              'Unrelated OAuth connector',
              '["https://open.feishu.cn/open-apis/"]'::jsonb,
              '[]'::jsonb,
              '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
              '[]'::jsonb,
              'oauth',
              $4
            )
        `,
        [
          matchedConnectorId,
          orgId,
          matchedInstallationId,
          userId,
          mismatchedConnectorId,
          mismatchedInstallationId,
          orphanConnectorId,
          orphanSlugId,
          unrelatedConnectorId,
          unrelatedSlugId,
        ],
      );
      await client.query(
        `
          INSERT INTO "org_custom_connector_oauth_configs" (
            "connector_id",
            "org_id",
            "provider_adapter",
            "client_id",
            "encrypted_client_secret",
            "authorization_url",
            "token_url",
            "token_endpoint_auth_method",
            "pkce_method"
          ) VALUES
            (
              $1,
              $2,
              'feishu',
              'cli_matched',
              'encrypted-matched-secret',
              'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
              'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
              'client_secret_post',
              'none'
            ),
            (
              $3,
              $2,
              'feishu',
              'cli_wrong',
              'encrypted-mismatched-secret',
              'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
              'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
              'client_secret_post',
              'none'
            ),
            (
              $4,
              $2,
              'feishu',
              'cli_orphan',
              'encrypted-orphan-secret',
              'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
              'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
              'client_secret_post',
              'none'
            ),
            (
              $5,
              $2,
              'standard',
              'cli_unrelated',
              'encrypted-unrelated-secret',
              'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
              'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
              'client_secret_post',
              'none'
            )
        `,
        [
          matchedConnectorId,
          orgId,
          mismatchedConnectorId,
          orphanConnectorId,
          unrelatedConnectorId,
        ],
      );
      await client.query("COMMIT");
      await client.query(
        `
          INSERT INTO "feishu_org_installations" (
            "id",
            "org_id",
            "owner_user_id",
            "app_id",
            "encrypted_app_secret",
            "encrypted_verification_token",
            "encrypted_encrypt_key",
            "default_compose_id"
          ) VALUES
            (
              $1,
              $2,
              $3,
              'cli_matched',
              'encrypted-matched-secret',
              'encrypted-matched-verification-token',
              'encrypted-matched-key',
              $4
            ),
            (
              $5,
              $2,
              $3,
              'cli_mismatched',
              'encrypted-mismatched-secret',
              'encrypted-mismatched-verification-token',
              'encrypted-mismatched-key',
              $4
            )
        `,
        [
          matchedInstallationId,
          orgId,
          userId,
          composeId,
          mismatchedInstallationId,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        "0940_reconcile_feishu_custom_connector_ownership",
      );

      const ownershipRows = await client.query<{
        customConnectorId: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "custom_connector_id" AS "customConnectorId"
          FROM "feishu_org_installations"
          WHERE "org_id" = $1
          ORDER BY "id"
        `,
        [orgId],
      );
      assert.deepEqual(ownershipRows.rows, [
        {
          id: matchedInstallationId,
          customConnectorId: matchedConnectorId,
        },
        {
          id: mismatchedInstallationId,
          customConnectorId: null,
        },
      ]);
      const connectorRows = await client.query<{ id: string }>(
        `
          SELECT "id"
          FROM "org_custom_connectors"
          WHERE "org_id" = $1
          ORDER BY "id"
        `,
        [orgId],
      );
      assert.deepEqual(connectorRows.rows, [
        { id: matchedConnectorId },
        { id: unrelatedConnectorId },
      ]);

      const migrationSql = readFileSync(
        path.join(
          MIGRATIONS_DIR,
          "0940_reconcile_feishu_custom_connector_ownership.sql",
        ),
        "utf-8",
      );
      await client.query(migrationSql);
      const rerunRows = await client.query<{
        customConnectorId: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "custom_connector_id" AS "customConnectorId"
          FROM "feishu_org_installations"
          WHERE "org_id" = $1
          ORDER BY "id"
        `,
        [orgId],
      );
      assert.deepEqual(rerunRows.rows, ownershipRows.rows);
      const rerunConnectorRows = await client.query<{ id: string }>(
        `
          SELECT "id"
          FROM "org_custom_connectors"
          WHERE "org_id" = $1
          ORDER BY "id"
        `,
        [orgId],
      );
      assert.deepEqual(rerunConnectorRows.rows, connectorRows.rows);

      console.log("   ✅ exact legacy ownership is reconciled");
      console.log("   ✅ unlinked generated connectors are removed");
      console.log("   ✅ unrelated reserved-slug connectors remain intact");
      console.log("   ✅ cleanup reruns without changing ownership\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateLatestSnapshotAccuracy(): Promise<void> {
  console.log("=== Phase 1.5: Validate Latest Snapshot Accuracy ===\n");

  const TEST_DB = "migration_snapshot_accuracy_test";

  // Get the latest migration index from journal
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  if (entries.length === 0) {
    throw new Error("No migrations found in journal");
  }

  const latestEntry = entries[entries.length - 1];
  if (!latestEntry) {
    throw new Error("Failed to get latest migration entry");
  }

  const latestIdx = latestEntry.idx;

  console.log(`   Validating latest snapshot (migration ${latestIdx})\n`);

  // Create clean test database
  await createDatabase(TEST_DB);
  const dbUrl = createTestDbUrl(TEST_DB);

  try {
    // Apply all migrations
    await runMigrations(dbUrl);

    // Extract schema from database
    const dbSchema = await extractSchemaFromDb(dbUrl);

    // Load latest snapshot
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(latestIdx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshotSchema = extractSchemaFromSnapshot(snapshotPath);

    // Compare
    const { matches, differences } = compareSchemas(
      dbSchema,
      snapshotSchema,
      latestIdx,
    );

    if (matches) {
      console.log(
        `   ✅ Latest snapshot (${latestIdx}) accurately reflects final DB state`,
      );
    } else {
      console.error(
        `   ❌ Latest snapshot (${latestIdx}) does NOT match final DB state:`,
      );
      for (const diff of differences) {
        console.error(`      ${diff}`);
      }
      console.error(`\n   🔧 How to fix:`);
      console.error(`      1. Reset database: pnpm -F @okouai/db db:reset`);
      console.error(
        `      2. Delete the latest migration file (${String(latestIdx).padStart(4, "0")}_*.sql)`,
      );
      console.error(`      3. Remove migration entry from meta/_journal.json`);
      console.error(
        `      4. Delete the latest snapshot (${String(latestIdx).padStart(4, "0")}_snapshot.json)`,
      );
      console.error(
        `      5. Generate migration: pnpm -F @okouai/db db:generate`,
      );
      console.error(`      6. Apply migration: pnpm -F @okouai/db db:migrate`);
      console.error(
        `\n   ⚠️  IMPORTANT: Never manually write migration files!`,
      );
      console.error(
        `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
      );
      console.error(
        `      Manual migrations cause snapshot/database mismatches.\n`,
      );
      throw new Error(
        `Latest snapshot ${latestIdx} accuracy validation failed`,
      );
    }
  } finally {
    await dropDatabase(TEST_DB);
  }

  console.log();
}

const CANONICAL_CHAT_EVENT_STORAGE_PREVIOUS_MIGRATION = "0885_mighty_ken_ellis";
const CANONICAL_CHAT_EVENT_STORAGE_MIGRATION =
  "0886_backfill_canonical_chat_event_storage";

async function readCanonicalBackfillDigests(client: Client): Promise<{
  readonly chatEvents: string;
  readonly zeroRuns: string;
}> {
  const digest = async (query: string): Promise<string> => {
    const result = await client.query<{ digest: string }>(query);
    const value = result.rows[0]?.digest;
    if (!value) {
      throw new Error("Canonical backfill digest query returned no row");
    }
    return value;
  };
  return {
    chatEvents: await digest(`
      SELECT md5(COALESCE(
        string_agg(to_jsonb("event")::text, '' ORDER BY "event"."id"),
        ''
      )) AS "digest"
      FROM "chat_events" AS "event"
    `),
    zeroRuns: await digest(`
      SELECT md5(COALESCE(
        string_agg(to_jsonb("run")::text, '' ORDER BY "run"."id"),
        ''
      )) AS "digest"
      FROM "zero_runs" AS "run"
    `),
  };
}

async function validateCanonicalChatEventStorageBackfill(): Promise<void> {
  console.log("=== Validate canonical chat event storage backfill ===\n");
  const testDb = "migration_canonical_chat_event_storage_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000088601",
    threadAId: "00000000-0000-4000-8000-000000088602",
    threadBId: "00000000-0000-4000-8000-000000088603",
    goalAId: "00000000-0000-4000-8000-000000088604",
    goalBId: "00000000-0000-4000-8000-000000088605",
    sessionId: "00000000-0000-4000-8000-000000088606",
    goalZeroRunId: "00000000-0000-4000-8000-000000088607",
    danglingZeroRunId: "00000000-0000-4000-8000-000000088608",
    conflictZeroRunId: "00000000-0000-4000-8000-000000088609",
    multiLeafEventId: "00000000-0000-4000-8000-000000088610",
    userMessageEventId: "00000000-0000-4000-8000-000000088611",
    thinkingEventId: "00000000-0000-4000-8000-000000088612",
    usageEventId: "00000000-0000-4000-8000-000000088613",
    allLeavesEventId: "00000000-0000-4000-8000-000000088614",
    allNullEventId: "00000000-0000-4000-8000-000000088615",
    goalOpenEventId: "00000000-0000-4000-8000-000000088616",
    interruptLegacyEventId: "00000000-0000-4000-8000-000000088617",
    interruptCanonicalEventId: "00000000-0000-4000-8000-000000088618",
    goalOutputEventId: "00000000-0000-4000-8000-000000088619",
    goalInputEventId: "00000000-0000-4000-8000-000000088620",
    goalDanglingEventId: "00000000-0000-4000-8000-000000088621",
    dualWriteEventId: "00000000-0000-4000-8000-000000088622",
    conflictInterruptEventId: "00000000-0000-4000-8000-000000088623",
    conflictContextEventId: "00000000-0000-4000-8000-000000088624",
    concurrentInsertEventId: "00000000-0000-4000-8000-000000088625",
    legacyInterruptRunId: "00000000-0000-4000-8000-000000088630",
    canonicalInterruptRunId: "00000000-0000-4000-8000-000000088631",
    usageRunId: "00000000-0000-4000-8000-000000088632",
    conflictOwnerRunId: "00000000-0000-4000-8000-000000088633",
    duplicateProbeInterruptsRunId: "00000000-0000-4000-8000-000000088634",
    conflictInterruptTargetRunId: "00000000-0000-4000-8000-000000088635",
    missingGoalId: "00000000-0000-4000-8000-000000088636",
    duplicateProbeEventId: "00000000-0000-4000-8000-000000088637",
    conflictContextId: "00000000-0000-4000-8000-000000088638",
  } as const;
  const nestedNullUserMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "text", text: "canonical backfill probe" }],
    compatibilityProbe: { nested: null },
  });
  const goalUserMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "goal", goalBrief: "canonical backfill goal" }],
  });
  const usagePayload = {
    version: 1,
    totalCredits: 2.5,
    settledAt: "2026-08-01T00:00:00.000Z",
    breakdown: [
      {
        kind: "run",
        credits: 2.5,
        providers: [{ provider: "pi", credits: 2.5 }],
      },
    ],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CANONICAL_CHAT_EVENT_STORAGE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'canonical-backfill-user', 'canonical-backfill', 'canonical-backfill-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, 'canonical-backfill-org', 'canonical-backfill-user', 'canonical-backfill')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" ("id", "user_id", "org_id", "agent_compose_id")
          VALUES ($1, 'canonical-backfill-user', 'canonical-backfill-org', $2)
        `,
        [fixture.sessionId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_runs" ("id", "user_id", "session_id", "status", "prompt", "org_id")
          VALUES
            ($1, 'canonical-backfill-user', $4, 'completed', 'goal continuation run', 'canonical-backfill-org'),
            ($2, 'canonical-backfill-user', $4, 'completed', 'dangling goal run', 'canonical-backfill-org'),
            ($3, 'canonical-backfill-user', $4, 'completed', 'conflicting goal run', 'canonical-backfill-org')
        `,
        [
          fixture.goalZeroRunId,
          fixture.danglingZeroRunId,
          fixture.conflictZeroRunId,
          fixture.sessionId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" ("id", "user_id", "agent_compose_id", "title", "last_chat_event_seq_id")
          VALUES
            ($1, 'canonical-backfill-user', $3, 'canonical backfill thread A', 100),
            ($2, 'canonical-backfill-user', $3, 'canonical backfill thread B', 100)
        `,
        [fixture.threadAId, fixture.threadBId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id", "org_id", "owner_user_id", "agent_id", "chat_thread_id",
            "status", "objective", "objective_brief"
          )
          VALUES
            ($1, 'canonical-backfill-org', 'canonical-backfill-user', $3, $4, 'active', 'Goal A objective', 'Goal A'),
            ($2, 'canonical-backfill-org', 'canonical-backfill-user', $3, $5, 'active', 'Goal B objective', 'Goal B')
        `,
        [
          fixture.goalAId,
          fixture.goalBId,
          fixture.composeId,
          fixture.threadAId,
          fixture.threadBId,
        ],
      );

      // Legacy chat_events written before the dual-write release: payload,
      // canonical interrupt run_id, and goal context_id are still absent.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "usage_payload", "interrupts_run_id",
            "run_group_id", "event_type", "payload", "context_type", "context_id",
            "content", "user_message", "thinking", "error", "seq_id"
          )
          VALUES
            ($1, $14, NULL, NULL, NULL, NULL, 'output.error', NULL, NULL, NULL,
              'output failed', NULL, NULL, 'output error', 1),
            ($2, $14, NULL, NULL, NULL, NULL, 'input.prompt', NULL, 'web', NULL,
              NULL, $16::jsonb, NULL, NULL, 2),
            ($3, $14, NULL, NULL, NULL, NULL, 'output.thinking', NULL, NULL, NULL,
              NULL, NULL, 'legacy thinking', NULL, 3),
            ($4, $14, $12, $18::jsonb, NULL, NULL, 'usage.recorded', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 4),
            ($5, $14, NULL, $18::jsonb, NULL, NULL, 'output.message', NULL, NULL, NULL,
              'all leaves', $16::jsonb, 'all leaves thinking', 'all leaves error', 5),
            ($6, $14, NULL, NULL, NULL, NULL, 'browser.open', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 6),
            ($7, $14, NULL, NULL, NULL, NULL, 'goal.open', NULL, NULL, NULL,
              'Goal A objective', NULL, NULL, NULL, 7),
            ($8, $14, NULL, NULL, $10, NULL, 'control.interrupt', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 8),
            ($9, $14, $11, NULL, $11, NULL, 'control.interrupt', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 9),
            ($13, $14, NULL, NULL, NULL, $19, 'output.message', NULL, NULL, NULL,
              'goal result', NULL, NULL, NULL, 10),
            ($20, $14, NULL, NULL, NULL, $19, 'input.goal', NULL, 'goal', NULL,
              NULL, $17::jsonb, NULL, NULL, 11),
            ($21, $15, NULL, NULL, NULL, $22, 'output.message', NULL, NULL, NULL,
              'dangling goal result', NULL, NULL, NULL, 1)
        `,
        [
          fixture.multiLeafEventId,
          fixture.userMessageEventId,
          fixture.thinkingEventId,
          fixture.usageEventId,
          fixture.allLeavesEventId,
          fixture.allNullEventId,
          fixture.goalOpenEventId,
          fixture.interruptLegacyEventId,
          fixture.interruptCanonicalEventId,
          fixture.legacyInterruptRunId,
          fixture.canonicalInterruptRunId,
          fixture.usageRunId,
          fixture.goalOutputEventId,
          fixture.threadAId,
          fixture.threadBId,
          nestedNullUserMessage,
          goalUserMessage,
          JSON.stringify(usagePayload),
          fixture.goalAId,
          fixture.goalInputEventId,
          fixture.goalDanglingEventId,
          fixture.goalBId,
        ],
      );
      // A row the dual-write release already stored canonically must survive
      // the backfill byte-for-byte.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
          )
          VALUES ($1, $2, 'output.message', $3::jsonb, 'dual write result', 12)
        `,
        [
          fixture.dualWriteEventId,
          fixture.threadAId,
          JSON.stringify({ content: "dual write result" }),
        ],
      );

      // Pre-dual-write zero_runs rows predate the goal-only bridge trigger,
      // which now forces run_group_id := goal_id on every write. Disable it
      // while seeding that historical shape.
      await client.query(
        `ALTER TABLE "zero_runs" DISABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await client.query(
        `
          INSERT INTO "zero_runs" ("id", "trigger_source", "chat_thread_id", "run_group_id", "goal_id")
          VALUES
            ($1, 'goal', $3, $4, NULL),
            ($2, 'goal', $3, $5, NULL)
        `,
        [
          fixture.goalZeroRunId,
          fixture.danglingZeroRunId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.missingGoalId,
        ],
      );
      await client.query(
        `ALTER TABLE "zero_runs" ENABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );

      const dualWriteBefore = await client.query<{ row: unknown }>(
        `SELECT to_jsonb("chat_events") AS "row" FROM "chat_events" WHERE "id" = $1`,
        [fixture.dualWriteEventId],
      );

      // Conflicting canonical values must abort the migration before any
      // mutation, one explicit diagnostic per conflict family.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "interrupts_run_id", "event_type", "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'control.interrupt', 21)
        `,
        [
          fixture.conflictInterruptEventId,
          fixture.threadAId,
          fixture.conflictOwnerRunId,
          fixture.conflictInterruptTargetRunId,
        ],
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /control\.interrupt rows whose run_id conflicts with interrupts_run_id/u,
      );
      await client.query(`DELETE FROM "chat_events" WHERE "id" = $1`, [
        fixture.conflictInterruptEventId,
      ]);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_group_id", "event_type", "context_type",
            "context_id", "content", "seq_id"
          )
          VALUES ($1, $2, $3, 'output.message', 'teams', $4, 'conflicting context', 20)
        `,
        [
          fixture.conflictContextEventId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.conflictContextId,
        ],
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /goal-grouped rows whose context conflicts with run_group_id/u,
      );
      await client.query(`DELETE FROM "chat_events" WHERE "id" = $1`, [
        fixture.conflictContextEventId,
      ]);

      await client.query(
        `ALTER TABLE "zero_runs" DISABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await client.query(
        `
          INSERT INTO "zero_runs" ("id", "trigger_source", "chat_thread_id", "run_group_id", "goal_id")
          VALUES ($1, 'goal', $2, $3, $4)
        `,
        [
          fixture.conflictZeroRunId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.goalBId,
        ],
      );
      await client.query(
        `ALTER TABLE "zero_runs" ENABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /zero_runs has .* rows whose goal_id conflicts with run_group_id/u,
      );
      await client.query(`DELETE FROM "zero_runs" WHERE "id" = $1`, [
        fixture.conflictZeroRunId,
      ]);

      // Goal B disappears the way production goals do; its chat event keeps a
      // dangling run_group_id that the backfill must still canonicalize.
      await client.query(`DELETE FROM "thread_goals" WHERE "id" = $1`, [
        fixture.goalBId,
      ]);

      // One eligible row stays locked by a concurrent writer while the
      // migration runs; the same transaction also appends a dual-write-shaped
      // row mid-flight. FOR UPDATE SKIP LOCKED plus the restart pass must
      // catch the locked row after commit and leave the new row untouched.
      const lockClient = new Client({ connectionString: testDbUrl });
      await lockClient.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `SELECT 1 FROM "chat_events" WHERE "id" = $1 FOR UPDATE`,
          [fixture.userMessageEventId],
        );
        await lockClient.query(
          `
            INSERT INTO "chat_events" (
              "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
            )
            VALUES ($1, $2, 'output.message', $3::jsonb, 'concurrent dual write', 90)
          `,
          [
            fixture.concurrentInsertEventId,
            fixture.threadBId,
            JSON.stringify({ content: "concurrent dual write" }),
          ],
        );
        const migrated = applyMigrationsUpToTag(
          client,
          CANONICAL_CHAT_EVENT_STORAGE_MIGRATION,
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 600);
        });
        await lockClient.query("COMMIT");
        await migrated;
      } finally {
        await lockClient.end();
      }

      const canonicalRows = await client.query<{
        id: string;
        payload: unknown;
        runId: string | null;
        interruptsRunId: string | null;
        runGroupId: string | null;
        contextType: string | null;
        contextId: string | null;
      }>(
        `
          SELECT
            "id",
            "payload",
            "run_id" AS "runId",
            "interrupts_run_id" AS "interruptsRunId",
            "run_group_id" AS "runGroupId",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" = ANY($1::uuid[])
          ORDER BY "id"
        `,
        [
          [
            fixture.multiLeafEventId,
            fixture.userMessageEventId,
            fixture.thinkingEventId,
            fixture.usageEventId,
            fixture.allLeavesEventId,
            fixture.allNullEventId,
            fixture.goalOpenEventId,
            fixture.interruptLegacyEventId,
            fixture.interruptCanonicalEventId,
            fixture.goalOutputEventId,
            fixture.goalInputEventId,
            fixture.goalDanglingEventId,
            fixture.concurrentInsertEventId,
          ],
        ],
      );
      const canonicalRow = (id: string) => {
        const row = canonicalRows.rows.find((candidate) => {
          return candidate.id === id;
        });
        if (!row) {
          throw new Error(`Missing canonical backfill fixture row ${id}`);
        }
        return row;
      };

      assert.deepEqual(canonicalRow(fixture.multiLeafEventId).payload, {
        content: "output failed",
        error: "output error",
      });
      const backfilledUserMessage = canonicalRow(fixture.userMessageEventId);
      assert.deepEqual(backfilledUserMessage.payload, {
        userMessage: JSON.parse(nestedNullUserMessage),
      });
      const probedPayload = backfilledUserMessage.payload as {
        userMessage: { compatibilityProbe: { nested: unknown } };
      };
      assert.equal(probedPayload.userMessage.compatibilityProbe.nested, null);
      assert.deepEqual(canonicalRow(fixture.thinkingEventId).payload, {
        thinking: "legacy thinking",
      });
      assert.deepEqual(canonicalRow(fixture.usageEventId).payload, {
        usage: usagePayload,
      });
      assert.deepEqual(canonicalRow(fixture.allLeavesEventId).payload, {
        content: "all leaves",
        userMessage: JSON.parse(nestedNullUserMessage),
        thinking: "all leaves thinking",
        error: "all leaves error",
        usage: usagePayload,
      });
      assert.equal(canonicalRow(fixture.allNullEventId).payload, null);
      assert.deepEqual(canonicalRow(fixture.goalOpenEventId).payload, {
        content: "Goal A objective",
      });
      assert.deepEqual(canonicalRow(fixture.interruptLegacyEventId), {
        id: fixture.interruptLegacyEventId,
        payload: null,
        runId: fixture.legacyInterruptRunId,
        interruptsRunId: fixture.legacyInterruptRunId,
        runGroupId: null,
        contextType: null,
        contextId: null,
      });
      assert.deepEqual(canonicalRow(fixture.interruptCanonicalEventId), {
        id: fixture.interruptCanonicalEventId,
        payload: null,
        runId: fixture.canonicalInterruptRunId,
        interruptsRunId: fixture.canonicalInterruptRunId,
        runGroupId: null,
        contextType: null,
        contextId: null,
      });
      assert.deepEqual(canonicalRow(fixture.goalOutputEventId), {
        id: fixture.goalOutputEventId,
        payload: { content: "goal result" },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalAId,
        contextType: "goal",
        contextId: fixture.goalAId,
      });
      assert.deepEqual(canonicalRow(fixture.goalInputEventId), {
        id: fixture.goalInputEventId,
        payload: { userMessage: JSON.parse(goalUserMessage) },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalAId,
        contextType: "goal",
        contextId: fixture.goalAId,
      });
      assert.deepEqual(canonicalRow(fixture.goalDanglingEventId), {
        id: fixture.goalDanglingEventId,
        payload: { content: "dangling goal result" },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalBId,
        contextType: "goal",
        contextId: fixture.goalBId,
      });
      assert.deepEqual(canonicalRow(fixture.concurrentInsertEventId).payload, {
        content: "concurrent dual write",
      });
      assert.equal(
        canonicalRow(fixture.concurrentInsertEventId).contextType,
        null,
      );

      const dualWriteAfter = await client.query<{ row: unknown }>(
        `SELECT to_jsonb("chat_events") AS "row" FROM "chat_events" WHERE "id" = $1`,
        [fixture.dualWriteEventId],
      );
      assert.deepEqual(dualWriteAfter.rows, dualWriteBefore.rows);

      const zeroRunRows = await client.query<{
        id: string;
        runGroupId: string | null;
        goalId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId", "goal_id" AS "goalId"
          FROM "zero_runs"
          WHERE "id" = ANY($1::uuid[])
          ORDER BY "id"
        `,
        [[fixture.goalZeroRunId, fixture.danglingZeroRunId]],
      );
      assert.deepEqual(zeroRunRows.rows, [
        {
          id: fixture.goalZeroRunId,
          runGroupId: fixture.goalAId,
          goalId: fixture.goalAId,
        },
        {
          id: fixture.danglingZeroRunId,
          runGroupId: fixture.missingGoalId,
          goalId: null,
        },
      ]);

      const canonicalInterruptIndex = await client.query<{
        indexdef: string;
      }>(`
        SELECT "indexdef"
        FROM "pg_indexes"
        WHERE "tablename" = 'chat_events'
          AND "indexname" = 'chat_events_control_interrupt_run_id_unique'
      `);
      assert.equal(canonicalInterruptIndex.rows.length, 1);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_control_interrupt_run_id_unique",
        query: `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "interrupts_run_id", "event_type", "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'control.interrupt', 95)
        `,
        values: [
          fixture.duplicateProbeEventId,
          fixture.threadAId,
          fixture.legacyInterruptRunId,
          fixture.duplicateProbeInterruptsRunId,
        ],
      });

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.multiLeafEventId,
      );
      // The narrowed canonicalization window must be closed again: even the
      // no-op canonical image is rejected once the strict trigger is back.
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_events" SET "payload" = "payload" WHERE "id" = $1`,
        rowId: fixture.multiLeafEventId,
      });

      // Rerunning the finished migration must be a no-op: the batches find no
      // eligible rows and every assertion still holds.
      const digestsBeforeRerun = await readCanonicalBackfillDigests(client);
      const migrationSql = await fs.readFile(
        path.join(
          MIGRATIONS_DIR,
          `${CANONICAL_CHAT_EVENT_STORAGE_MIGRATION}.sql`,
        ),
        "utf-8",
      );
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim().length === 0) {
          continue;
        }
        await client.query(statement);
      }
      assert.deepEqual(
        await readCanonicalBackfillDigests(client),
        digestsBeforeRerun,
      );
      console.log(
        "   ✅ Canonical chat event storage backfill converges, aborts on conflicts, and reruns cleanly\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_PHYSICAL_CONTRACTION_PREVIOUS_MIGRATION =
  "0909_canonical_chat_event_writes";
const CHAT_EVENT_PHYSICAL_CONTRACTION_MIGRATION =
  "0910_contract_legacy_chat_event_storage";

interface CanonicalChatEventWriterProbe {
  readonly batch: string;
  readonly idConflict: string;
  readonly insert: string;
  readonly replacementConflict: string;
  readonly runLifecycleConflict: string;
}

async function exerciseCanonicalChatEventWriter(
  client: Client,
  args: {
    readonly ids: {
      readonly batchA: string;
      readonly batchB: string;
      readonly insert: string;
      readonly replacement: string;
      readonly replacementConflict: string;
      readonly replacementTarget: string;
      readonly terminal: string;
      readonly terminalConflict: string;
      readonly terminalRun: string;
    };
    readonly seqId: number;
    readonly threadId: string;
  },
): Promise<CanonicalChatEventWriterProbe> {
  const database = drizzle(client);
  const insert = database
    .insert(chatEvents)
    .values({
      id: args.ids.insert,
      chatThreadId: args.threadId,
      eventType: "output.message",
      payload: { content: "canonical insert" },
      seqId: args.seqId,
    })
    .returning({ id: chatEvents.id });
  const insertSql = insert.toSQL().sql;
  assert.deepEqual(await insert, [{ id: args.ids.insert }]);

  const idConflict = database
    .insert(chatEvents)
    .values({
      id: args.ids.insert,
      chatThreadId: args.threadId,
      eventType: "output.message",
      payload: { content: "id conflict" },
      seqId: args.seqId + 1,
    })
    .onConflictDoNothing({ target: chatEvents.id })
    .returning({ id: chatEvents.id });
  const idConflictSql = idConflict.toSQL().sql;
  assert.deepEqual(await idConflict, []);

  await database.insert(chatEvents).values({
    id: args.ids.terminal,
    chatThreadId: args.threadId,
    runId: args.ids.terminalRun,
    eventType: "run.completed",
    payload: { content: "completed" },
    seqId: args.seqId + 2,
  });
  const runLifecycleConflict = database
    .insert(chatEvents)
    .values({
      id: args.ids.terminalConflict,
      chatThreadId: args.threadId,
      runId: args.ids.terminalRun,
      eventType: "run.failed",
      payload: { content: "failed", error: "late failure" },
      seqId: args.seqId + 3,
    })
    .onConflictDoNothing({
      target: chatEvents.runId,
      where: chatEventTerminalPredicate(chatEvents.eventType),
    })
    .returning({ id: chatEvents.id });
  const runLifecycleConflictSql = runLifecycleConflict.toSQL().sql;
  assert.deepEqual(await runLifecycleConflict, []);

  const batch = database
    .insert(chatEvents)
    .values([
      {
        id: args.ids.batchA,
        chatThreadId: args.threadId,
        eventType: "browser.open",
        seqId: args.seqId + 4,
      },
      {
        id: args.ids.batchB,
        chatThreadId: args.threadId,
        eventType: "browser.close",
        seqId: args.seqId + 4,
      },
    ])
    .onConflictDoNothing()
    .returning({ id: chatEvents.id });
  const batchSql = batch.toSQL().sql;
  assert.equal((await batch).length, 1);

  const userMessage = {
    version: 1 as const,
    parts: [{ type: "text" as const, text: "replacement target" }],
  };
  await database.insert(chatEvents).values({
    id: args.ids.replacementTarget,
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    payload: { userMessage },
    contextType: "web",
    seqId: args.seqId + 5,
  });
  await database.insert(chatEvents).values({
    id: args.ids.replacement,
    chatThreadId: args.threadId,
    revokesEventId: args.ids.replacementTarget,
    eventType: "input.rejected",
    payload: { userMessage, error: "replacement rejected" },
    contextType: "web",
    seqId: args.seqId + 6,
  });
  const replacementConflict = database
    .insert(chatEvents)
    .values({
      id: args.ids.replacementConflict,
      chatThreadId: args.threadId,
      revokesEventId: args.ids.replacementTarget,
      eventType: "input.rejected",
      payload: { userMessage, error: "duplicate replacement" },
      contextType: "web",
      seqId: args.seqId + 7,
    })
    .onConflictDoNothing()
    .returning({ id: chatEvents.id });
  const replacementConflictSql = replacementConflict.toSQL().sql;
  assert.deepEqual(await replacementConflict, []);

  const statements = {
    batch: batchSql,
    idConflict: idConflictSql,
    insert: insertSql,
    replacementConflict: replacementConflictSql,
    runLifecycleConflict: runLifecycleConflictSql,
  };
  for (const statement of Object.values(statements)) {
    assert.doesNotMatch(
      statement,
      /content|user_message|thinking|error|usage_payload|interrupts_run_id|run_group_id/u,
    );
  }
  return statements;
}

async function validateChatEventPhysicalContraction(): Promise<void> {
  console.log("=== Validate physical chat-event storage contraction ===\n");
  const testDb = "migration_chat_event_physical_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000091001",
    threadId: "00000000-0000-4000-8000-000000091002",
    goalId: "00000000-0000-4000-8000-000000091003",
    sessionId: "00000000-0000-4000-8000-000000091004",
    zeroRunId: "00000000-0000-4000-8000-000000091005",
    legacyEventId: "00000000-0000-4000-8000-000000091006",
    interruptEventId: "00000000-0000-4000-8000-000000091007",
    interruptRunId: "00000000-0000-4000-8000-000000091008",
    goalOpenId: "00000000-0000-4000-8000-000000091009",
    divergentEventId: "00000000-0000-4000-8000-000000091010",
    validGoalCloseId: "00000000-0000-4000-8000-000000091011",
    invalidGoalOpenId: "00000000-0000-4000-8000-000000091012",
    before: {
      batchA: "00000000-0000-4000-8000-000000091020",
      batchB: "00000000-0000-4000-8000-000000091021",
      insert: "00000000-0000-4000-8000-000000091022",
      replacement: "00000000-0000-4000-8000-000000091023",
      replacementConflict: "00000000-0000-4000-8000-000000091024",
      replacementTarget: "00000000-0000-4000-8000-000000091025",
      terminal: "00000000-0000-4000-8000-000000091026",
      terminalConflict: "00000000-0000-4000-8000-000000091027",
      terminalRun: "00000000-0000-4000-8000-000000091028",
    },
    after: {
      batchA: "00000000-0000-4000-8000-000000091030",
      batchB: "00000000-0000-4000-8000-000000091031",
      insert: "00000000-0000-4000-8000-000000091032",
      replacement: "00000000-0000-4000-8000-000000091033",
      replacementConflict: "00000000-0000-4000-8000-000000091034",
      replacementTarget: "00000000-0000-4000-8000-000000091035",
      terminal: "00000000-0000-4000-8000-000000091036",
      terminalConflict: "00000000-0000-4000-8000-000000091037",
      terminalRun: "00000000-0000-4000-8000-000000091038",
    },
  } as const;
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: "legacy payload" }],
  };
  const usage = {
    version: 1,
    totalCredits: 1,
    settledAt: "2026-08-12T00:00:00.000Z",
    breakdown: [],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_PHYSICAL_CONTRACTION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await addCurrentChatEventOfficialWorkflowQueueStorage(client);
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'physical-contract-user', 'physical-contract', 'physical-contract-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, 'physical-contract-org', 'physical-contract-user', 'physical-contract')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "title", "last_chat_event_seq_id"
          ) VALUES ($1, 'physical-contract-user', $2, 'physical contract', 100)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id", "org_id", "owner_user_id", "agent_id", "chat_thread_id",
            "status", "objective", "objective_brief"
          ) VALUES (
            $1, 'physical-contract-org', 'physical-contract-user', $2, $3,
            'active', 'Physical contraction goal', 'Physical contraction goal'
          )
        `,
        [fixture.goalId, fixture.composeId, fixture.threadId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" (
            "id", "user_id", "org_id", "agent_compose_id"
          ) VALUES (
            $1, 'physical-contract-user', 'physical-contract-org', $2
          )
        `,
        [fixture.sessionId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id", "user_id", "session_id", "status", "prompt", "org_id"
          ) VALUES (
            $1, 'physical-contract-user', $2, 'completed',
            'physical contraction goal run', 'physical-contract-org'
          )
        `,
        [fixture.zeroRunId, fixture.sessionId],
      );
      await client.query(
        `
          INSERT INTO "zero_runs" (
            "id", "trigger_source", "chat_thread_id", "run_group_id", "goal_id"
          ) VALUES ($1, 'goal', $2, $3, $3)
        `,
        [fixture.zeroRunId, fixture.threadId, fixture.goalId],
      );

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "usage_payload",
            "interrupts_run_id", "run_group_id", "event_type", "payload",
            "context_type", "context_id", "content", "user_message",
            "thinking", "error", "seq_id"
          ) VALUES (
            $1, $2, NULL, $3::jsonb, NULL, $4, 'output.message', $5::jsonb,
            'goal', $4, 'legacy content', $6::jsonb,
            'legacy thinking', 'legacy error', 1
          )
        `,
        [
          fixture.legacyEventId,
          fixture.threadId,
          JSON.stringify(usage),
          fixture.goalId,
          JSON.stringify({
            content: "legacy content",
            userMessage,
            thinking: "legacy thinking",
            error: "legacy error",
            usage,
          }),
          JSON.stringify(userMessage),
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "interrupts_run_id",
            "event_type", "seq_id"
          ) VALUES ($1, $2, $3, $3, 'control.interrupt', 2)
        `,
        [fixture.interruptEventId, fixture.threadId, fixture.interruptRunId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
          ) VALUES (
            $1, $2, 'goal.open', '{"content":"Canonical objective"}'::jsonb,
            'Canonical objective', 3
          )
        `,
        [fixture.goalOpenId, fixture.threadId],
      );

      const beforeWriterSql = await exerciseCanonicalChatEventWriter(client, {
        ids: fixture.before,
        seqId: 10,
        threadId: fixture.threadId,
      });
      // Migration 0910 intentionally asserts its historical exact column set.
      // The private queue column arrived later, so remove the test-only current
      // ORM shim while 0910 runs and restore it for the post-migration probe.
      await removeCurrentChatEventOfficialWorkflowQueueStorage(client);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
          ) VALUES (
            $1, $2, 'output.message', '{"content":"canonical"}'::jsonb,
            'divergent', 30
          )
        `,
        [fixture.divergentEventId, fixture.threadId],
      );
      await assert.rejects(
        applyMigrationsUpToTag(
          client,
          CHAT_EVENT_PHYSICAL_CONTRACTION_MIGRATION,
        ),
        /legacy payload leaves lack canonical values/u,
      );
      await client.query(`DELETE FROM "chat_events" WHERE "id" = $1`, [
        fixture.divergentEventId,
      ]);

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_PHYSICAL_CONTRACTION_MIGRATION,
      );
      await addCurrentChatEventOfficialWorkflowQueueStorage(client);

      const retained = await client.query<{ row: Record<string, unknown> }>(
        `
          SELECT to_jsonb("event") AS "row"
          FROM "chat_events" AS "event"
          WHERE "id" = $1
        `,
        [fixture.legacyEventId],
      );
      const retainedRow = retained.rows[0]?.row;
      assert.ok(retainedRow);
      assert.deepEqual(Object.keys(retainedRow).sort(), [
        "chat_thread_id",
        "context_id",
        "context_type",
        "created_at",
        "event_type",
        "id",
        "payload",
        "required_official_workflow_ids",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_id",
        "seq_id",
      ]);
      assert.deepEqual(retainedRow.payload, {
        content: "legacy content",
        userMessage,
        thinking: "legacy thinking",
        error: "legacy error",
        usage,
      });
      assert.equal(retainedRow.context_type, "goal");
      assert.equal(retainedRow.context_id, fixture.goalId);

      const catalog = await client.query<{
        bridgeFunctionCount: number;
        bridgeTriggerCount: number;
        legacyColumnCount: number;
        legacyIndexCount: number;
        zeroRunGoalId: string | null;
      }>(
        `
          SELECT
            (
              SELECT count(*)::integer
              FROM "information_schema"."columns"
              WHERE ("table_name", "column_name") IN (
                ('chat_events', 'content'),
                ('chat_events', 'user_message'),
                ('chat_events', 'thinking'),
                ('chat_events', 'error'),
                ('chat_events', 'usage_payload'),
                ('chat_events', 'interrupts_run_id'),
                ('chat_events', 'run_group_id'),
                ('zero_runs', 'run_group_id')
              )
            ) AS "legacyColumnCount",
            (
              SELECT count(*)::integer
              FROM "pg_indexes"
              WHERE "indexname" IN (
                'chat_events_usage_run_id_idx',
                'chat_events_interrupts_run_id_not_null_unique',
                'chat_events_run_thinking_unique',
                'idx_zero_runs_run_group'
              )
            ) AS "legacyIndexCount",
            (
              SELECT count(*)::integer
              FROM "pg_trigger"
              WHERE NOT "tgisinternal"
                AND "tgname" IN (
                  'bridge_goal_only_chat_event_run_group_0810',
                  'bridge_goal_only_zero_run_group_0810',
                  'bridge_invalidated_goal_continuation_0829'
                )
            ) AS "bridgeTriggerCount",
            (
              SELECT count(*)::integer
              FROM "pg_proc"
              WHERE "proname" IN (
                'bridge_goal_only_chat_event_run_group_0810',
                'bridge_goal_only_zero_run_group_0810',
                'bridge_invalidated_goal_continuation_0829'
              )
            ) AS "bridgeFunctionCount",
            (
              SELECT "goal_id"::text
              FROM "zero_runs"
              WHERE "id" = $1
            ) AS "zeroRunGoalId"
        `,
        [fixture.zeroRunId],
      );
      assert.deepEqual(catalog.rows, [
        {
          bridgeFunctionCount: 0,
          bridgeTriggerCount: 0,
          legacyColumnCount: 0,
          legacyIndexCount: 0,
          zeroRunGoalId: fixture.goalId,
        },
      ]);

      const goalMarker = await client.query<{
        columns: string[];
        definition: string;
        validated: boolean;
      }>(`
        SELECT
          to_jsonb(ARRAY(
            SELECT "attribute"."attname"
            FROM unnest("constraint"."conkey") AS "key"("attnum")
            INNER JOIN "pg_attribute" AS "attribute"
              ON "attribute"."attrelid" = "constraint"."conrelid"
              AND "attribute"."attnum" = "key"."attnum"
            ORDER BY "attribute"."attname"
          )) AS "columns",
          pg_get_constraintdef("constraint"."oid", true) AS "definition",
          "constraint"."convalidated" AS "validated"
        FROM "pg_constraint" AS "constraint"
        WHERE "constraint"."conrelid" = 'public.chat_events'::regclass
          AND "constraint"."conname" = 'chat_events_goal_marker_payload_check'
      `);
      assert.deepEqual(goalMarker.rows[0]?.columns, [
        "context_id",
        "context_type",
        "event_type",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_id",
      ]);
      assert.equal(goalMarker.rows[0]?.validated, true);
      assert.doesNotMatch(
        goalMarker.rows[0]?.definition ?? "",
        /content|user_message|thinking|error|usage_payload|interrupts_run_id|run_group_id/u,
      );

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "seq_id"
          ) VALUES ($1, $2, 'goal.close', 60)
        `,
        [fixture.validGoalCloseId, fixture.threadId],
      );
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chat_events_goal_marker_payload_check",
        query: `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "event_type", "payload", "seq_id"
          ) VALUES (
            $1, $2, $3, 'goal.open', '{"content":"Invalid objective"}'::jsonb, 61
          )
        `,
        values: [
          fixture.invalidGoalOpenId,
          fixture.threadId,
          fixture.interruptRunId,
        ],
      });

      const afterWriterSql = await exerciseCanonicalChatEventWriter(client, {
        ids: fixture.after,
        seqId: 70,
        threadId: fixture.threadId,
      });
      assert.deepEqual(afterWriterSql, beforeWriterSql);
      await assertChatEventsAppendOnlyProtection(client, fixture.legacyEventId);

      console.log(
        "   ✅ legacy columns, indexes, and bridge objects are absent",
      );
      console.log(
        "   ✅ canonical payload, interrupt, goal, and zero-run data survive",
      );
      console.log(
        "   ✅ canonical insert and conflict SQL is unchanged across the drop",
      );
      console.log(
        "   ✅ canonical goal-marker and append-only invariants remain\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_RUN_SERVICE_TIER_PREVIOUS_MIGRATION = "0889_thankful_crusher_hogan";
const CHAT_RUN_SERVICE_TIER_MIGRATION =
  "0893_backfill_chat_run_service_tier_annotations";

const CHAT_RUN_SERVICE_TIER_FIXTURE = {
  composeId: "00000000-0000-4000-8000-000000089001",
  sessionId: "00000000-0000-4000-8000-000000089002",
  affectedThreadId: "00000000-0000-4000-8000-000000089003",
  unaffectedThreadId: "00000000-0000-4000-8000-000000089004",
  tailThreadId: "00000000-0000-4000-8000-000000089005",
  fastRunId: "00000000-0000-4000-8000-000000089006",
  annotatedFastRunId: "00000000-0000-4000-8000-000000089007",
  standardRunId: "00000000-0000-4000-8000-000000089008",
  modelLessFastRunId: "00000000-0000-4000-8000-000000089009",
  tailFastRunId: "00000000-0000-4000-8000-000000089010",
  fastEventId: "00000000-0000-4000-8000-000000089011",
  annotatedFastEventId: "00000000-0000-4000-8000-000000089012",
  standardEventId: "00000000-0000-4000-8000-000000089013",
  modelLessFastEventId: "00000000-0000-4000-8000-000000089014",
  tailFastEventId: "00000000-0000-4000-8000-000000089015",
  tailPrefixEventId: "00000000-0000-4000-8000-000000089016",
  affectedSnapshotId: "00000000-0000-4000-8000-000000089021",
  unaffectedSnapshotId: "00000000-0000-4000-8000-000000089022",
  tailSnapshotId: "00000000-0000-4000-8000-000000089023",
  concurrentSnapshotId: "00000000-0000-4000-8000-000000089024",
  staleTailSnapshotId: "00000000-0000-4000-8000-000000089025",
  orgId: "chat-run-service-tier-org",
  userId: "chat-run-service-tier-user",
} as const;

const CHAT_RUN_SERVICE_TIER_MESSAGES = {
  fast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  expectedFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
  annotatedFast: {
    version: 1,
    parts: [
      { type: "text", text: "already annotated fast run" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
  standard: {
    version: 1,
    parts: [
      { type: "text", text: "standard run" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  modelLessFast: {
    version: 1,
    parts: [{ type: "text", text: "fast run without a model part" }],
  },
  tailFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run in the postgres tail" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  expectedTailFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run in the postgres tail" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
} as const;

function assertChatRunServiceTierMigrationShape(migrationSql: string): void {
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/u);
  assert.doesNotMatch(
    migrationSql,
    /(?:DROP|DISABLE)\s+TRIGGER\s+"chat_events_reject_update"/u,
  );
  assert.equal((migrationSql.match(/\bLIMIT 500\b/gu) ?? []).length, 1);
  assert.equal(
    (migrationSql.match(/\bFOR UPDATE OF "candidate" SKIP LOCKED\b/gu) ?? [])
      .length,
    1,
  );
  assert.equal((migrationSql.match(/\bCOMMIT\b/gu) ?? []).length, 1);
  assert.match(
    migrationSql,
    /SET "user_message" =[\s\S]*"payload" = jsonb_set/u,
  );
  assert.equal(
    (migrationSql.match(/"chat_thread_id" = ANY\(updated_thread_ids\)/gu) ?? [])
      .length,
    2,
  );
  assert.doesNotMatch(migrationSql, /updated_seq_ids/u);
}

async function seedChatRunServiceTierOwners(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'chat-run-service-tier', $3)
    `,
    [fixture.composeId, fixture.userId, fixture.orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "title",
        "last_chat_event_seq_id"
      )
      VALUES
        ($1, $4, $5, 'affected snapshot', 2),
        ($2, $4, $5, 'unaffected snapshot', 2),
        ($3, $4, $5, 'postgres tail snapshot', 2)
    `,
    [
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
      fixture.userId,
      fixture.composeId,
    ],
  );
}

async function seedChatRunServiceTierRuns(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id"
      )
      VALUES
        ($1, $6, $7, 'running', 'fast run', $8),
        ($2, $6, $7, 'running', 'annotated fast run', $8),
        ($3, $6, $7, 'running', 'standard run', $8),
        ($4, $6, $7, 'running', 'model-less fast run', $8),
        ($5, $6, $7, 'running', 'tail fast run', $8)
    `,
    [
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      fixture.userId,
      fixture.sessionId,
      fixture.orgId,
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_runs" (
        "id", "trigger_source", "selected_model", "codex_service_tier",
        "chat_thread_id"
      )
      VALUES
        ($1, 'web', 'gpt-5.6-sol', 'fast', $6),
        ($2, 'web', 'gpt-5.6-sol', 'fast', $6),
        ($3, 'web', 'gpt-5.6-sol', NULL, $7),
        ($4, 'web', 'gpt-5.6-sol', 'fast', $7),
        ($5, 'web', 'gpt-5.6-sol', 'fast', $8)
    `,
    [
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
    ],
  );
}

async function seedChatRunServiceTierEvents(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  await client.query(
    `
      INSERT INTO "chat_events" (
        "id", "chat_thread_id", "run_id", "event_type", "context_type",
        "payload", "user_message", "seq_id"
      )
      VALUES
        ($1, $7, $10, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $15::jsonb), $15::jsonb, 1),
        ($2, $7, $11, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $16::jsonb), $16::jsonb, 2),
        ($3, $8, $12, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $17::jsonb), $17::jsonb, 1),
        ($4, $8, $13, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $18::jsonb), $18::jsonb, 2),
        ($5, $9, NULL, 'output.message', NULL, NULL, NULL, 1),
        ($6, $9, $14, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $19::jsonb), $19::jsonb, 2)
    `,
    [
      fixture.fastEventId,
      fixture.annotatedFastEventId,
      fixture.standardEventId,
      fixture.modelLessFastEventId,
      fixture.tailPrefixEventId,
      fixture.tailFastEventId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      JSON.stringify(messages.fast),
      JSON.stringify(messages.annotatedFast),
      JSON.stringify(messages.standard),
      JSON.stringify(messages.modelLessFast),
      JSON.stringify(messages.tailFast),
    ],
  );
}

async function seedChatRunServiceTierSnapshots(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "chat_event_snapshots" (
        "id", "chat_thread_id", "last_seq_id", "archive_schema_version",
        "object_key", "is_head"
      )
      VALUES
        ($1, $4, 2, 3, 'migration/affected.ndjson.gz', true),
        ($2, $5, 2, 3, 'migration/unaffected.ndjson.gz', true),
        ($3, $6, 1, 3, 'migration/tail.ndjson.gz', true)
    `,
    [
      fixture.affectedSnapshotId,
      fixture.unaffectedSnapshotId,
      fixture.tailSnapshotId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
    ],
  );
}

async function seedChatRunServiceTierFixture(client: Client): Promise<void> {
  await seedChatRunServiceTierOwners(client);
  await seedChatRunServiceTierRuns(client);
  await seedChatRunServiceTierEvents(client);
  await seedChatRunServiceTierSnapshots(client);
}

async function waitForPostgresBlock(
  observer: Client,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `
        SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS "blocked"
      `,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) {
      return;
    }
    await observer.query(`SELECT pg_sleep(0.01)`);
  }
  assert.fail("migration did not wait for the concurrent snapshot publisher");
}

async function databaseBackendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    `SELECT pg_backend_pid() AS "pid"`,
  );
  const pid = result.rows[0]?.pid;
  assert.ok(pid);
  return pid;
}

async function applyBackfillWhileSnapshotPublisherWins(
  client: Client,
  testDbUrl: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  const publisher = new Client({ connectionString: testDbUrl });
  await publisher.connect();
  let transactionOpen = false;
  try {
    // The production publisher reads event bytes before opening its short
    // expected-parent swap transaction. Capture that stale candidate from a
    // head which does not cover the event that 0893 will update.
    const staleTailCandidate = await publisher.query<{
      archiveSchemaVersion: number;
      canonicalUserMessage: unknown;
      lastSeqId: string;
      objectKey: string;
    }>(
      `
        SELECT
          "snapshot"."archive_schema_version" AS "archiveSchemaVersion",
          "event"."payload" -> 'userMessage' AS "canonicalUserMessage",
          "snapshot"."last_seq_id" AS "lastSeqId",
          "snapshot"."object_key" AS "objectKey"
        FROM "chat_event_snapshots" AS "snapshot"
        INNER JOIN "chat_events" AS "event"
          ON "event"."chat_thread_id" = "snapshot"."chat_thread_id"
        WHERE "snapshot"."id" = $1
          AND "snapshot"."is_head"
          AND "event"."id" = $2
      `,
      [fixture.tailSnapshotId, fixture.tailFastEventId],
    );
    assert.deepEqual(staleTailCandidate.rows, [
      {
        archiveSchemaVersion: 3,
        canonicalUserMessage: messages.tailFast,
        lastSeqId: "1",
        objectKey: "migration/tail.ndjson.gz",
      },
    ]);

    const migrationPid = await databaseBackendPid(client);
    const publisherPid = await databaseBackendPid(publisher);
    await publisher.query("BEGIN");
    transactionOpen = true;
    const demoted = await publisher.query(
      `
        UPDATE "chat_event_snapshots"
        SET "is_head" = false
        WHERE "id" = $1 AND "is_head"
        RETURNING "id"
      `,
      [fixture.affectedSnapshotId],
    );
    assert.equal(demoted.rowCount, 1);
    await publisher.query(
      `
        INSERT INTO "chat_event_snapshots" (
          "id", "chat_thread_id", "parent_snapshot_id", "last_seq_id",
          "archive_schema_version", "object_key", "is_head"
        )
        VALUES ($1, $2, $3, 2, 3, 'migration/concurrent.ndjson.gz', true)
      `,
      [
        fixture.concurrentSnapshotId,
        fixture.affectedThreadId,
        fixture.affectedSnapshotId,
      ],
    );

    const migrationPromise = applyMigrationsUpToTag(
      client,
      CHAT_RUN_SERVICE_TIER_MIGRATION,
    );
    try {
      await waitForPostgresBlock(publisher, migrationPid, publisherPid);
      await publisher.query("COMMIT");
      transactionOpen = false;
      await migrationPromise;

      // Complete the stale publisher's short CAS after the migration commits.
      // 0893 must have demoted its shorter expected parent, otherwise this
      // would publish a current v4 head containing the old event bytes above.
      await publisher.query("BEGIN");
      transactionOpen = true;
      const staleTailParent = staleTailCandidate.rows[0];
      assert.ok(staleTailParent);
      const staleTailDemoted = await publisher.query(
        `
          UPDATE "chat_event_snapshots"
          SET "is_head" = false
          WHERE "id" = $1
            AND "chat_thread_id" = $2
            AND "is_head"
            AND "archive_schema_version" = $3
            AND "last_seq_id" = $4
            AND "object_key" = $5
          RETURNING "id"
        `,
        [
          fixture.tailSnapshotId,
          fixture.tailThreadId,
          staleTailParent.archiveSchemaVersion,
          staleTailParent.lastSeqId,
          staleTailParent.objectKey,
        ],
      );
      if (staleTailDemoted.rowCount === 1) {
        await publisher.query(
          `
            INSERT INTO "chat_event_snapshots" (
              "id", "chat_thread_id", "parent_snapshot_id", "last_seq_id",
              "archive_schema_version", "object_key", "is_head"
            )
            VALUES ($1, $2, $3, 2, 4, 'migration/stale-tail.ndjson.gz', true)
          `,
          [
            fixture.staleTailSnapshotId,
            fixture.tailThreadId,
            fixture.tailSnapshotId,
          ],
        );
      }
      await publisher.query("COMMIT");
      transactionOpen = false;
      assert.equal(staleTailDemoted.rowCount, 0);
    } catch (error) {
      if (transactionOpen) {
        await publisher.query("ROLLBACK");
        transactionOpen = false;
      }
      await migrationPromise.catch(() => {
        return undefined;
      });
      throw error;
    }
  } finally {
    if (transactionOpen) {
      await publisher.query("ROLLBACK");
    }
    await publisher.end();
  }
}

async function chatEventsRejectFunctionDefinition(
  client: Client,
): Promise<string> {
  const result = await client.query<{ definition: string }>(`
    SELECT pg_get_functiondef(
      'public.reject_chat_event_source_update()'::regprocedure
    ) AS "definition"
  `);
  const definition = result.rows[0]?.definition;
  assert.ok(definition);
  return definition;
}

async function assertChatRunServiceTierMessages(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  const result = await client.query<{
    id: string;
    canonicalUserMessage: unknown;
    legacyUserMessage: unknown;
  }>(
    `
      SELECT
        "id",
        "payload" -> 'userMessage' AS "canonicalUserMessage",
        "user_message" AS "legacyUserMessage"
      FROM "chat_events"
      WHERE "id" IN ($1, $2, $3, $4, $5)
      ORDER BY "id"
    `,
    [
      fixture.fastEventId,
      fixture.annotatedFastEventId,
      fixture.standardEventId,
      fixture.modelLessFastEventId,
      fixture.tailFastEventId,
    ],
  );
  assert.deepEqual(result.rows, [
    {
      id: fixture.fastEventId,
      canonicalUserMessage: messages.expectedFast,
      legacyUserMessage: messages.expectedFast,
    },
    {
      id: fixture.annotatedFastEventId,
      canonicalUserMessage: messages.annotatedFast,
      legacyUserMessage: messages.annotatedFast,
    },
    {
      id: fixture.standardEventId,
      canonicalUserMessage: messages.standard,
      legacyUserMessage: messages.standard,
    },
    {
      id: fixture.modelLessFastEventId,
      canonicalUserMessage: messages.modelLessFast,
      legacyUserMessage: messages.modelLessFast,
    },
    {
      id: fixture.tailFastEventId,
      canonicalUserMessage: messages.expectedTailFast,
      legacyUserMessage: messages.expectedTailFast,
    },
  ]);
}

async function assertChatRunServiceTierSnapshotHeads(
  client: Client,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const result = await client.query<{ id: string; isHead: boolean }>(
    `
      SELECT "id", "is_head" AS "isHead"
      FROM "chat_event_snapshots"
      WHERE "id" IN ($1, $2, $3, $4, $5)
      ORDER BY "id"
    `,
    [
      fixture.affectedSnapshotId,
      fixture.unaffectedSnapshotId,
      fixture.tailSnapshotId,
      fixture.concurrentSnapshotId,
      fixture.staleTailSnapshotId,
    ],
  );
  assert.deepEqual(result.rows, [
    { id: fixture.affectedSnapshotId, isHead: false },
    { id: fixture.unaffectedSnapshotId, isHead: true },
    { id: fixture.tailSnapshotId, isHead: false },
    { id: fixture.concurrentSnapshotId, isHead: false },
  ]);
}

async function assertChatRunServiceTierMigrationCleanup(
  client: Client,
  strictRejectFunctionDefinition: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const artifacts = await client.query<{
    annotationFunctionPresent: boolean;
    backfillProcedurePresent: boolean;
  }>(`
    SELECT
      to_regprocedure(
        'public.annotate_chat_event_priority_0893(jsonb)'
      ) IS NOT NULL AS "annotationFunctionPresent",
      to_regprocedure(
        'public.backfill_chat_run_service_tier_annotations_0893()'
      ) IS NOT NULL AS "backfillProcedurePresent"
  `);
  assert.deepEqual(artifacts.rows, [
    { annotationFunctionPresent: false, backfillProcedurePresent: false },
  ]);
  assert.equal(
    await chatEventsRejectFunctionDefinition(client),
    strictRejectFunctionDefinition,
  );
  await assertChatEventsAppendOnlyProtection(client, fixture.fastEventId);
}

async function rerunChatRunServiceTierMigration(
  client: Client,
  migrationSql: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  for (const statement of statements) {
    await client.query(statement);
  }
  const remaining = await client.query<{ count: string }>(`
    SELECT count(*)::text AS "count"
    FROM "chat_events" AS "event"
    INNER JOIN "zero_runs" AS "run" ON "run"."id" = "event"."run_id"
    WHERE "run"."codex_service_tier" = 'fast'
      AND (
        "event"."payload" -> 'userMessage'
          IS DISTINCT FROM "event"."user_message"
        OR (
          jsonb_typeof(
            "event"."payload" -> 'userMessage' -> 'parts'
          ) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              "event"."payload" -> 'userMessage' -> 'parts'
            ) AS "part"
            WHERE "part" ->> 'type' = 'model'
              AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
          )
        )
      )
  `);
  assert.deepEqual(remaining.rows, [{ count: "0" }]);
  await assertChatEventsAppendOnlyProtection(client, fixture.fastEventId);
}

async function validateChatRunServiceTierAnnotationBackfill(): Promise<void> {
  console.log("=== Validate chat-run service tier annotation backfill ===\n");
  const testDb = "migration_chat_run_service_tier_annotation_test";
  const testDbUrl = createTestDbUrl(testDb);
  const migrationSql = await fs.readFile(
    path.join(
      MIGRATIONS_DIR,
      "0893_backfill_chat_run_service_tier_annotations.sql",
    ),
    "utf8",
  );
  assertChatRunServiceTierMigrationShape(migrationSql);

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_RUN_SERVICE_TIER_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await seedChatRunServiceTierFixture(client);

      const strictRejectFunctionDefinition =
        await chatEventsRejectFunctionDefinition(client);

      await applyBackfillWhileSnapshotPublisherWins(client, testDbUrl);

      await assertChatRunServiceTierMessages(client);

      await assertChatRunServiceTierSnapshotHeads(client);

      await assertChatRunServiceTierMigrationCleanup(
        client,
        strictRejectFunctionDefinition,
      );
      await rerunChatRunServiceTierMigration(client, migrationSql);

      console.log("   ✅ proven fast runs receive priority annotations");
      console.log("   ✅ standard and model-less messages remain unchanged");
      console.log(
        "   ✅ a concurrently published covering snapshot head is demoted",
      );
      console.log(
        "   ✅ a stale publisher cannot extend a non-covering snapshot head",
      );
      console.log(
        "   ✅ backfill is batched, retryable, and restores append-only protection\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const RETIRED_RUN_MODEL_STATE_PREVIOUS_MIGRATION = "0902_colorful_mandrill";
const RETIRED_RUN_MODEL_STATE_MIGRATION = "0905_retire_legacy_run_model_state";

async function validateRetiredRunModelStateMigration(): Promise<void> {
  console.log("=== Validate retired run-model state migration ===\n");
  const testDb = "migration_retired_run_model_state_test";
  const testDbUrl = createTestDbUrl(testDb);
  const providerIds = {
    openRouter: "00000000-0000-4000-8000-000000089801",
    openAi: "00000000-0000-4000-8000-000000089802",
    deepSeek: "00000000-0000-4000-8000-000000089803",
    zai: "00000000-0000-4000-8000-000000089804",
  } as const;
  const composeIds = {
    unrestricted: "00000000-0000-4000-8000-000000089811",
    restricted: "00000000-0000-4000-8000-000000089812",
    zai: "00000000-0000-4000-8000-000000089813",
  } as const;
  const customSurfaceId = "00000000-0000-4000-8000-000000089821";

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      RETIRED_RUN_MODEL_STATE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "org_plan_entitlements" (
            "org_id",
            "plan_key",
            "plan_rank",
            "source",
            "status",
            "restricted_vm0_models"
          ) VALUES
            ('migration-model-unrestricted', 'pro', 2, 'fixture', 'active', false),
            ('migration-model-restricted', 'limited', 0, 'fixture', 'suspended', true),
            ('migration-model-custom', 'pro', 2, 'fixture', 'active', false),
            ('migration-model-zai', 'pro', 2, 'fixture', 'active', false)
        `,
      );
      await client.query(
        `
          INSERT INTO "model_providers" (
            "id",
            "type",
            "is_default",
            "selected_model",
            "user_id",
            "org_id"
          ) VALUES
            ($1, 'openrouter-api-key', true, 'anthropic/claude-opus-4.7', '__org__', 'migration-model-unrestricted'),
            ($2, 'openai-api-key', true, 'openai/gpt-5.5', '__org__', 'migration-model-restricted'),
            ($3, 'deepseek', false, 'deepseek-v4-flash', '__org__', 'migration-model-restricted'),
            ($4, 'zai-api-key', true, 'glm-4.7', '__org__', 'migration-model-zai')
        `,
        Object.values(providerIds),
      );
      await client.query(
        `
          INSERT INTO "secrets" (
            "id",
            "name",
            "encrypted_value",
            "type",
            "user_id",
            "org_id"
          ) VALUES (
            '00000000-0000-4000-8000-000000089822',
            'migration-model-custom',
            'fixture',
            'user',
            '__org__',
            'migration-model-custom'
          );
          INSERT INTO "model_provider_connections" (
            "id",
            "org_id",
            "display_name",
            "secret_id"
          ) VALUES (
            '00000000-0000-4000-8000-000000089823',
            'migration-model-custom',
            'Migration gateway',
            '00000000-0000-4000-8000-000000089822'
          );
          INSERT INTO "model_provider_surfaces" (
            "id",
            "connection_id",
            "protocol",
            "api_base_url",
            "auth_header_name",
            "auth_header_template",
            "model_mappings"
          ) VALUES (
            '${customSurfaceId}',
            '00000000-0000-4000-8000-000000089823',
            'openai-responses',
            'https://example.test/v1',
            'Authorization',
            'Bearer {{secret}}',
            '{"gpt-5.5":"vendor/old","gpt-5.6-sol":"vendor/new"}'::jsonb
          )
        `,
      );
      await client.query(
        `
          INSERT INTO "org_model_policies" (
            "org_id",
            "model",
            "is_default",
            "default_provider_type",
            "credential_scope",
            "model_provider_id",
            "model_provider_surface_id"
          ) VALUES
            ('migration-model-unrestricted', 'claude-opus-4-7', true, 'openrouter-api-key', 'org', $1, NULL),
            ('migration-model-unrestricted', 'claude-opus-4-8', false, 'vm0', 'org', NULL, NULL),
            ('migration-model-restricted', 'gpt-5.5', true, 'openai-api-key', 'org', $2, NULL),
            ('migration-model-restricted', 'deepseek-v4-flash', false, 'deepseek', 'org', $3, NULL),
            ('migration-model-custom', 'gpt-5.5', true, 'vercel-ai-gateway-codex', 'org', NULL, $4),
            ('migration-model-zai', 'glm-5.2', true, 'vm0', 'org', NULL, NULL)
        `,
        [
          providerIds.openRouter,
          providerIds.openAi,
          providerIds.deepSeek,
          customSurfaceId,
        ],
      );
      await client.query(
        `
          INSERT INTO "org_members_metadata" (
            "org_id",
            "user_id",
            "selected_model",
            "service_tier"
          ) VALUES
            ('migration-model-unrestricted', 'migration-member-unrestricted', 'claude-opus-4-7', 'priority'),
            ('migration-model-restricted', 'migration-member-restricted', 'gpt-5.5', 'priority')
        `,
      );
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES
            ($1, 'migration-member-unrestricted', 'migration-unrestricted-agent', 'migration-model-unrestricted'),
            ($2, 'migration-member-restricted', 'migration-restricted-agent', 'migration-model-restricted'),
            ($3, 'migration-member-zai', 'migration-zai-agent', 'migration-model-zai')
        `,
        [composeIds.unrestricted, composeIds.restricted, composeIds.zai],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id",
            "org_id",
            "owner",
            "name",
            "model_provider_id",
            "selected_model"
          ) VALUES
            ($1, 'migration-model-unrestricted', 'migration-member-unrestricted', 'migration-unrestricted-agent', $4, 'claude-opus-4-7'),
            ($2, 'migration-model-restricted', 'migration-member-restricted', 'migration-restricted-agent', $5, 'gpt-5.5'),
            ($3, 'migration-model-zai', 'migration-member-zai', 'migration-zai-agent', $6, NULL)
        `,
        [
          composeIds.unrestricted,
          composeIds.restricted,
          composeIds.zai,
          providerIds.openRouter,
          providerIds.openAi,
          providerIds.zai,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "selected_model",
            "codex_service_tier"
          ) VALUES (
            $1,
            'migration-member-restricted',
            $2,
            'gpt-5.5',
            'priority'
          )
        `,
        ["00000000-0000-4000-8000-000000089831", composeIds.restricted],
      );

      await applyMigrationsUpToTag(client, RETIRED_RUN_MODEL_STATE_MIGRATION);

      const policies = await client.query<{
        orgId: string;
        model: string;
        isDefault: boolean;
        providerType: string;
        providerId: string | null;
        surfaceId: string | null;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "model",
          "is_default" AS "isDefault",
          "default_provider_type" AS "providerType",
          "model_provider_id" AS "providerId",
          "model_provider_surface_id" AS "surfaceId"
        FROM "org_model_policies"
        ORDER BY "org_id", "model"
      `);
      assert.deepEqual(policies.rows, [
        {
          orgId: "migration-model-custom",
          model: "gpt-5.6-sol",
          isDefault: true,
          providerType: "vercel-ai-gateway-codex",
          providerId: null,
          surfaceId: customSurfaceId,
        },
        {
          orgId: "migration-model-restricted",
          model: "deepseek-v4-flash",
          isDefault: true,
          providerType: "vm0",
          providerId: null,
          surfaceId: null,
        },
        {
          orgId: "migration-model-unrestricted",
          model: "claude-opus-4-8",
          isDefault: true,
          providerType: "vm0",
          providerId: null,
          surfaceId: null,
        },
        {
          orgId: "migration-model-zai",
          model: "deepseek-v4-flash",
          isDefault: true,
          providerType: "vm0",
          providerId: null,
          surfaceId: null,
        },
      ]);

      const members = await client.query<{
        orgId: string;
        selectedModel: string;
        serviceTier: string | null;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "selected_model" AS "selectedModel",
          "service_tier" AS "serviceTier"
        FROM "org_members_metadata"
        ORDER BY "org_id"
      `);
      assert.deepEqual(members.rows, [
        {
          orgId: "migration-model-restricted",
          selectedModel: "deepseek-v4-flash",
          serviceTier: null,
        },
        {
          orgId: "migration-model-unrestricted",
          selectedModel: "claude-opus-4-8",
          serviceTier: null,
        },
      ]);

      const providers = await client.query<{
        type: string;
        isDefault: boolean;
        selectedModel: string | null;
      }>(`
        SELECT
          "type",
          "is_default" AS "isDefault",
          "selected_model" AS "selectedModel"
        FROM "model_providers"
        ORDER BY "type"
      `);
      assert.deepEqual(providers.rows, [
        {
          type: "deepseek",
          isDefault: false,
          selectedModel: "deepseek-v4-flash",
        },
        { type: "openai-api-key", isDefault: false, selectedModel: null },
        {
          type: "openrouter-api-key",
          isDefault: true,
          selectedModel: "anthropic/claude-opus-4.8",
        },
        { type: "zai-api-key", isDefault: false, selectedModel: null },
      ]);

      const agents = await client.query<{
        name: string;
        selectedModel: string | null;
        providerId: string | null;
      }>(`
        SELECT
          "name",
          "selected_model" AS "selectedModel",
          "model_provider_id" AS "providerId"
        FROM "zero_agents"
        ORDER BY "name"
      `);
      assert.deepEqual(agents.rows, [
        {
          name: "migration-restricted-agent",
          selectedModel: null,
          providerId: null,
        },
        {
          name: "migration-unrestricted-agent",
          selectedModel: "claude-opus-4-8",
          providerId: providerIds.openRouter,
        },
        {
          name: "migration-zai-agent",
          selectedModel: null,
          providerId: null,
        },
      ]);

      const thread = await client.query<{
        selectedModel: string;
        serviceTier: string;
      }>(`
        SELECT
          "selected_model" AS "selectedModel",
          "codex_service_tier" AS "serviceTier"
        FROM "chat_threads"
        WHERE "id" = '00000000-0000-4000-8000-000000089831'
      `);
      assert.deepEqual(thread.rows, [
        { selectedModel: "gpt-5.5", serviceTier: "priority" },
      ]);

      console.log("   ✅ replacement policies merge and transfer defaults");
      console.log("   ✅ restricted and incompatible routes fall back safely");
      console.log(
        "   ✅ current preferences and agents migrate without rewriting threads\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const USAGE_PACK_REFUND_SCHEMA_MIGRATION = "0898_usage_pack_credit_refunds";
const USAGE_PACK_INVITE_BACKFILL_MIGRATION =
  "0899_backfill_member_invite_usage_pack_required";
const USAGE_PACK_CHANGE_INDEX_MIGRATION =
  "0900_replace_scheduled_usage_pack_change";

async function validateUsagePackInviteLifecycleMigrations(): Promise<void> {
  console.log("=== Validate usage-pack invite lifecycle migrations ===\n");
  const testDb = "migration_usage_pack_invite_lifecycle_test";
  const testDbUrl = createTestDbUrl(testDb);
  await createDatabase(testDb);

  try {
    await runMigrationsUpToTag(testDbUrl, USAGE_PACK_REFUND_SCHEMA_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    try {
      await client.query(`
        INSERT INTO "org_plan_entitlements" (
          "org_id",
          "plan_key",
          "plan_rank",
          "source",
          "stripe_subscription_id"
        )
        VALUES
          ('org_usage_pack_active_pro', 'pro', 1, 'stripe', 'sub_active_pro'),
          ('org_usage_pack_active_team', 'team', 2, 'stripe', 'sub_active_team'),
          ('org_usage_pack_free', 'limited-free-1', 0, 'stripe', 'sub_free'),
          ('org_usage_pack_canceled', 'pro', 1, 'stripe', 'sub_canceled'),
          ('org_usage_pack_expired', 'team', 2, 'stripe', 'sub_expired'),
          ('org_usage_pack_invalid', 'pro', 1, 'stripe', 'sub_invalid'),
          ('org_usage_pack_mismatch', 'pro', 1, 'stripe', 'sub_entitlement')
      `);
      await client.query(`
        INSERT INTO "usage_pack_subscriptions" (
          "id",
          "org_id",
          "tier",
          "stripe_plan_price_id",
          "stripe_customer_id",
          "stripe_subscription_id",
          "subscription_status"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'price_plan_pro',
            'cus_active_pro',
            'sub_active_pro',
            'active'
          ),
          (
            '00000000-0000-4000-8000-000000090002',
            'org_usage_pack_active_team',
            'team',
            'price_plan_team',
            'cus_active_team',
            'sub_active_team',
            'trialing'
          ),
          (
            '00000000-0000-4000-8000-000000090003',
            'org_usage_pack_free',
            'pro',
            'price_plan_pro',
            'cus_free',
            'sub_free',
            'active'
          ),
          (
            '00000000-0000-4000-8000-000000090004',
            'org_usage_pack_canceled',
            'pro',
            'price_plan_pro',
            'cus_canceled',
            'sub_canceled',
            'canceled'
          ),
          (
            '00000000-0000-4000-8000-000000090005',
            'org_usage_pack_expired',
            'team',
            'price_plan_team',
            'cus_expired',
            'sub_expired',
            'incomplete_expired'
          ),
          (
            '00000000-0000-4000-8000-000000090006',
            'org_usage_pack_invalid',
            'pro',
            'price_plan_pro',
            'cus_invalid',
            'sub_invalid',
            'invalid'
          ),
          (
            '00000000-0000-4000-8000-000000090007',
            'org_usage_pack_mismatch',
            'pro',
            'price_plan_pro',
            'cus_mismatch',
            'sub_usage_pack',
            'active'
          )
      `);

      await applyMigrationsUpToTag(
        client,
        USAGE_PACK_INVITE_BACKFILL_MIGRATION,
      );
      const entitlements = await client.query<{
        memberInviteUsagePackRequired: boolean;
        orgId: string;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "member_invite_usage_pack_required" AS "memberInviteUsagePackRequired"
        FROM "org_plan_entitlements"
        WHERE "org_id" LIKE 'org_usage_pack_%'
        ORDER BY "org_id"
      `);
      assert.deepEqual(entitlements.rows, [
        {
          memberInviteUsagePackRequired: true,
          orgId: "org_usage_pack_active_pro",
        },
        {
          memberInviteUsagePackRequired: true,
          orgId: "org_usage_pack_active_team",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_canceled",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_expired",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_free",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_invalid",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_mismatch",
        },
      ]);

      await client.query(`
        INSERT INTO "usage_pack_subscription_changes" (
          "id",
          "usage_pack_subscription_id",
          "org_id",
          "source_tier",
          "target_tier",
          "status",
          "proration_timestamp",
          "immediate_amount_cents",
          "next_recurring_amount_cents",
          "currency",
          "preview_expires_at",
          "effective_at"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090011',
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'pro',
            'completed',
            1,
            0,
            0,
            'usd',
            '2035-01-01',
            '2035-02-01'
          ),
          (
            '00000000-0000-4000-8000-000000090012',
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'pro',
            'completed',
            2,
            0,
            0,
            'usd',
            '2035-01-01',
            '2035-02-01'
          )
      `);
      await applyMigrationsUpToTag(client, USAGE_PACK_CHANGE_INDEX_MIGRATION);

      await client.query(`
        INSERT INTO "usage_pack_allocation_changes" (
          "id",
          "usage_pack_subscription_id",
          "subscription_change_id",
          "org_id",
          "user_id",
          "kind",
          "status",
          "target_usage_pack_usd",
          "target_stripe_price_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090021',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090011',
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            20,
            'price_usage_pack_20'
          ),
          (
            '00000000-0000-4000-8000-000000090022',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090012',
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            50,
            'price_usage_pack_50'
          ),
          (
            '00000000-0000-4000-8000-000000090023',
            '00000000-0000-4000-8000-000000090001',
            NULL,
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            100,
            'price_usage_pack_100'
          ),
          (
            '00000000-0000-4000-8000-000000090024',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090011',
            'org_usage_pack_active_pro',
            'user_scheduled',
            'addition',
            'scheduled',
            20,
            'price_usage_pack_20'
          )
      `);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "uq_usage_pack_changes_current_user",
        query: `
          INSERT INTO "usage_pack_allocation_changes" (
            "usage_pack_subscription_id",
            "subscription_change_id",
            "org_id",
            "user_id",
            "kind",
            "status",
            "target_usage_pack_usd",
            "target_stripe_price_id"
          )
          VALUES (
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090012',
            'org_usage_pack_active_pro',
            'user_scheduled',
            'addition',
            'scheduled',
            50,
            'price_usage_pack_50'
          )
        `,
      });

      console.log(
        "   ✅ Active Pro and Team usage-pack subscriptions require invite packages",
      );
      console.log(
        "   ✅ Terminal, free, and mismatched subscriptions remain unchanged",
      );
      console.log(
        "   ✅ Grouped previews coexist while scheduled replacements remain unique\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const FINALIZE_INACTIVE_RUN_MODELS_PREVIOUS_MIGRATION =
  "0905_retire_legacy_run_model_state";
const FINALIZE_INACTIVE_RUN_MODELS_MIGRATION =
  "0908_finalize_inactive_run_model_stage_two";

async function validateInactiveRunModelFinalization(): Promise<void> {
  console.log("=== Validate inactive run-model Stage 2 finalization ===\n");
  const testDb = "migration_inactive_run_model_finalization_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  const client = new Client({ connectionString: testDbUrl });
  await client.connect();

  try {
    await applyMigrationsUpToTag(
      client,
      FINALIZE_INACTIVE_RUN_MODELS_PREVIOUS_MIGRATION,
    );

    await client.query(`
      INSERT INTO "org_plan_entitlements" (
        "org_id",
        "plan_key",
        "plan_rank",
        "source",
        "support_byok",
        "restricted_vm0_models"
      ) VALUES
        (
          'org-migration-0905-unrestricted',
          'pro',
          20,
          'migration-test',
          true,
          false
        ),
        (
          'org-migration-0905-restricted',
          'free',
          0,
          'migration-test',
          true,
          true
        );

      INSERT INTO "secrets" (
        "id",
        "name",
        "encrypted_value",
        "type",
        "user_id",
        "org_id"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090521',
          'anthropic-retained',
          'encrypted-anthropic',
          'org',
          '__org__',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090522',
          'moonshot-deleted',
          'encrypted-moonshot',
          'org',
          '__org__',
          'org-migration-0905-restricted'
        ),
        (
          '00000000-0000-4000-8000-000000090523',
          'unrelated-retained',
          'encrypted-unrelated',
          'org',
          '__org__',
          'org-migration-0905-restricted'
        ),
        (
          '00000000-0000-4000-8000-000000090524',
          'minimax-deleted',
          'encrypted-minimax',
          'org',
          '__org__',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090525',
          'zai-deleted',
          'encrypted-zai',
          'org',
          'user-migration-0905-zai',
          'org-migration-0905-unrestricted'
        );

      INSERT INTO "model_providers" (
        "id",
        "type",
        "secret_id",
        "is_default",
        "selected_model",
        "user_id",
        "org_id"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090511',
          'anthropic-api-key',
          '00000000-0000-4000-8000-000000090521',
          true,
          'anthropic/claude-opus-4.8',
          '__org__',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090512',
          'moonshot-api-key',
          '00000000-0000-4000-8000-000000090522',
          false,
          NULL,
          '__org__',
          'org-migration-0905-restricted'
        ),
        (
          '00000000-0000-4000-8000-000000090513',
          'vm0',
          NULL,
          true,
          'deepseek-v4-flash',
          '__org__',
          'org-migration-0905-restricted'
        ),
        (
          '00000000-0000-4000-8000-000000090514',
          'minimax-api-key',
          '00000000-0000-4000-8000-000000090524',
          true,
          NULL,
          'user-migration-0905-minimax',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090515',
          'vm0',
          NULL,
          false,
          'MiniMax-M3',
          'user-migration-0905-minimax',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090516',
          'zai-api-key',
          '00000000-0000-4000-8000-000000090525',
          true,
          NULL,
          'user-migration-0905-zai',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090517',
          'vm0',
          NULL,
          false,
          'glm-5.2',
          'user-migration-0905-zai',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090518',
          'minimax-api-key',
          '00000000-0000-4000-8000-000000090524',
          false,
          NULL,
          '__org__',
          'org-migration-0905-unrestricted'
        );

      INSERT INTO "org_model_policies" (
        "id",
        "org_id",
        "model",
        "is_default",
        "default_provider_type",
        "credential_scope",
        "model_provider_id"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090531',
          'org-migration-0905-unrestricted',
          'claude-opus-4-8',
          true,
          'anthropic-api-key',
          'org',
          '00000000-0000-4000-8000-000000090511'
        ),
        (
          '00000000-0000-4000-8000-000000090532',
          'org-migration-0905-unrestricted',
          'gpt-5.6-sol',
          false,
          'vm0',
          'org',
          NULL
        ),
        (
          '00000000-0000-4000-8000-000000090533',
          'org-migration-0905-restricted',
          'deepseek-v4-flash',
          true,
          'vm0',
          'org',
          NULL
        ),
        (
          '00000000-0000-4000-8000-000000090534',
          'org-migration-0905-unrestricted',
          'claude-sonnet-5',
          false,
          'vm0',
          'org',
          NULL
        ),
        (
          '00000000-0000-4000-8000-000000090535',
          'org-migration-0905-unrestricted',
          'claude-fable-5',
          false,
          'minimax-api-key',
          'org',
          '00000000-0000-4000-8000-000000090518'
        );

      INSERT INTO "org_members_metadata" (
        "org_id",
        "user_id",
        "selected_model",
        "service_tier"
      ) VALUES
        (
          'org-migration-0905-unrestricted',
          'user-migration-0905-unrestricted',
          'claude-opus-4-8',
          NULL
        ),
        (
          'org-migration-0905-restricted',
          'user-migration-0905-restricted',
          'deepseek-v4-flash',
          NULL
        ),
        (
          'org-migration-0905-unrestricted',
          'user-migration-0905-active-model',
          'claude-sonnet-5',
          NULL
        ),
        (
          'org-migration-0905-unrestricted',
          'user-migration-0905-gpt-successor',
          'gpt-5.6-sol',
          'priority'
        ),
        (
          'org-migration-0905-unrestricted',
          'user-migration-0905-unset',
          NULL,
          NULL
        );

      INSERT INTO "agent_composes" (
        "id",
        "user_id",
        "name",
        "org_id"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090501',
          'user-migration-0905-unrestricted',
          'migration-0905-unrestricted',
          'org-migration-0905-unrestricted'
        ),
        (
          '00000000-0000-4000-8000-000000090502',
          'user-migration-0905-restricted',
          'migration-0905-restricted',
          'org-migration-0905-restricted'
        ),
        (
          '00000000-0000-4000-8000-000000090503',
          'user-migration-0905-minimax',
          'migration-0905-minimax',
          'org-migration-0905-unrestricted'
        );

      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "model_provider_id",
        "model_provider_type",
        "model_provider_credential_scope",
        "selected_model",
        "codex_service_tier",
        "updated_at"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090541',
          'user-migration-0905-unrestricted',
          '00000000-0000-4000-8000-000000090501',
          '00000000-0000-4000-8000-000000090511',
          'anthropic-api-key',
          'org',
          'claude-opus-4-7',
          'flex',
          '2026-08-01 00:00:00'
        ),
        (
          '00000000-0000-4000-8000-000000090542',
          'user-migration-0905-restricted',
          '00000000-0000-4000-8000-000000090502',
          '00000000-0000-4000-8000-000000090512',
          'moonshot-api-key',
          'org',
          'claude-opus-4-7',
          'priority',
          '2026-08-02 00:00:00'
        ),
        (
          '00000000-0000-4000-8000-000000090543',
          'user-migration-0905-minimax',
          '00000000-0000-4000-8000-000000090503',
          '00000000-0000-4000-8000-000000090514',
          NULL,
          'org',
          NULL,
          'flex',
          '2026-08-03 00:00:00'
        ),
        (
          '00000000-0000-4000-8000-000000090544',
          'user-migration-0905-unrestricted',
          '00000000-0000-4000-8000-000000090501',
          NULL,
          'openai-api-key',
          'org',
          'gpt-5.5',
          'priority',
          '2026-08-04 00:00:00'
        ),
        (
          '00000000-0000-4000-8000-000000090545',
          'user-migration-0905-unrestricted',
          '00000000-0000-4000-8000-000000090501',
          '00000000-0000-4000-8000-000000090511',
          'anthropic-api-key',
          'org',
          'claude-sonnet-4-6',
          NULL,
          '2026-08-05 00:00:00'
        );

      INSERT INTO "zero_agents" (
        "id",
        "org_id",
        "owner",
        "name",
        "model_provider_id",
        "selected_model"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090501',
          'org-migration-0905-unrestricted',
          'user-migration-0905-unrestricted',
          'migration-0905-unrestricted',
          '00000000-0000-4000-8000-000000090511',
          'claude-opus-4-8'
        ),
        (
          '00000000-0000-4000-8000-000000090502',
          'org-migration-0905-restricted',
          'user-migration-0905-restricted',
          'migration-0905-restricted',
          NULL,
          'deepseek-v4-flash'
        ),
        (
          '00000000-0000-4000-8000-000000090503',
          'org-migration-0905-unrestricted',
          'user-migration-0905-minimax',
          'migration-0905-minimax',
          '00000000-0000-4000-8000-000000090514',
          NULL
        );

      INSERT INTO "agent_sessions" (
        "id",
        "user_id",
        "org_id",
        "agent_compose_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000090551',
        'user-migration-0905-unrestricted',
        'org-migration-0905-unrestricted',
        '00000000-0000-4000-8000-000000090501'
      );

      INSERT INTO "agent_runs" (
        "id",
        "user_id",
        "session_id",
        "status",
        "prompt",
        "org_id",
        "completed_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000090561',
        'user-migration-0905-unrestricted',
        '00000000-0000-4000-8000-000000090551',
        'completed',
        'Historical run remains immutable',
        'org-migration-0905-unrestricted',
        '2026-07-01 00:00:00'
      );

      INSERT INTO "zero_runs" (
        "id",
        "trigger_source",
        "model_provider",
        "model_provider_id",
        "model_provider_credential_scope",
        "selected_model"
      ) VALUES (
        '00000000-0000-4000-8000-000000090561',
        'web',
        'moonshot-api-key',
        '00000000-0000-4000-8000-000000090512',
        'org',
        'kimi-k3'
      );

      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content",
        "seq_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000090571',
        '00000000-0000-4000-8000-000000090541',
        'output.message',
        'Historical claude-opus-4-7 display payload',
        1
      );

      INSERT INTO "usage_pricing" (
        "id",
        "kind",
        "provider",
        "category",
        "unit_price",
        "unit_size"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000090581',
          'model',
          'claude-opus-4-7',
          'tokens.input',
          1,
          1000000
        ),
        (
          '00000000-0000-4000-8000-000000090582',
          'model',
          'MiniMax-M3',
          'tokens.input',
          1,
          1000000
        ),
        (
          '00000000-0000-4000-8000-000000090583',
          'model',
          'gpt-5.5',
          'tokens.input',
          1,
          1000000
        ),
        (
          '00000000-0000-4000-8000-000000090584',
          'model',
          'claude-sonnet-4-6',
          'tokens.input',
          1,
          1000000
        ),
        (
          '00000000-0000-4000-8000-000000090585',
          'image-recognition',
          'xiaomi/mimo-v2.5',
          'tokens.input',
          1,
          1000000
        ),
        (
          '00000000-0000-4000-8000-000000090586',
          'model',
          'glm-4.7',
          'tokens.input',
          1,
          1000000
        );
    `);

    await applyMigrationsUpToTag(
      client,
      FINALIZE_INACTIVE_RUN_MODELS_MIGRATION,
    );

    const assertMigratedState = async (): Promise<void> => {
      const policies = await client.query<{
        defaultProviderType: string;
        isDefault: boolean;
        model: string;
        modelProviderId: string | null;
        orgId: string;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "model",
          "is_default" AS "isDefault",
          "default_provider_type" AS "defaultProviderType",
          "model_provider_id"::text AS "modelProviderId"
        FROM "org_model_policies"
        ORDER BY "org_id", "model"
      `);
      assert.deepEqual(
        policies.rows,
        [
          {
            defaultProviderType: "vm0",
            isDefault: true,
            model: "deepseek-v4-flash",
            modelProviderId: null,
            orgId: "org-migration-0905-restricted",
          },
          {
            defaultProviderType: "vm0",
            isDefault: false,
            model: "claude-fable-5",
            modelProviderId: null,
            orgId: "org-migration-0905-unrestricted",
          },
          {
            defaultProviderType: "anthropic-api-key",
            isDefault: true,
            model: "claude-opus-4-8",
            modelProviderId: "00000000-0000-4000-8000-000000090511",
            orgId: "org-migration-0905-unrestricted",
          },
          {
            defaultProviderType: "vm0",
            isDefault: false,
            model: "claude-sonnet-4-6",
            modelProviderId: null,
            orgId: "org-migration-0905-unrestricted",
          },
          {
            defaultProviderType: "vm0",
            isDefault: false,
            model: "claude-sonnet-5",
            modelProviderId: null,
            orgId: "org-migration-0905-unrestricted",
          },
          {
            defaultProviderType: "vm0",
            isDefault: false,
            model: "gpt-5.5",
            modelProviderId: null,
            orgId: "org-migration-0905-unrestricted",
          },
          {
            defaultProviderType: "vm0",
            isDefault: false,
            model: "gpt-5.6-sol",
            modelProviderId: null,
            orgId: "org-migration-0905-unrestricted",
          },
        ].sort((left, right) => {
          return (
            left.orgId.localeCompare(right.orgId) ||
            left.model.localeCompare(right.model)
          );
        }),
      );

      const members = await client.query<{
        selectedModel: string | null;
        serviceTier: string | null;
        userId: string;
      }>(`
        SELECT
          "user_id" AS "userId",
          "selected_model" AS "selectedModel",
          "service_tier" AS "serviceTier"
        FROM "org_members_metadata"
        ORDER BY "user_id"
      `);
      assert.deepEqual(members.rows, [
        {
          selectedModel: "claude-sonnet-5",
          serviceTier: null,
          userId: "user-migration-0905-active-model",
        },
        {
          selectedModel: "gpt-5.6-sol",
          serviceTier: "priority",
          userId: "user-migration-0905-gpt-successor",
        },
        {
          selectedModel: "deepseek-v4-flash",
          serviceTier: null,
          userId: "user-migration-0905-restricted",
        },
        {
          selectedModel: "claude-opus-4-8",
          serviceTier: null,
          userId: "user-migration-0905-unrestricted",
        },
        {
          selectedModel: null,
          serviceTier: null,
          userId: "user-migration-0905-unset",
        },
      ]);

      const threads = await client.query<{
        codexServiceTier: string | null;
        modelProviderCredentialScope: string | null;
        modelProviderId: string | null;
        modelProviderType: string | null;
        selectedModel: string;
        updatedAt: string;
      }>(`
        SELECT
          "selected_model" AS "selectedModel",
          "model_provider_id"::text AS "modelProviderId",
          "model_provider_type" AS "modelProviderType",
          "model_provider_credential_scope" AS "modelProviderCredentialScope",
          "codex_service_tier" AS "codexServiceTier",
          to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
        FROM "chat_threads"
        ORDER BY "id"
      `);
      assert.deepEqual(threads.rows, [
        {
          codexServiceTier: null,
          modelProviderCredentialScope: null,
          modelProviderId: null,
          modelProviderType: null,
          selectedModel: "claude-opus-4-8",
          updatedAt: "2026-08-01 00:00:00",
        },
        {
          codexServiceTier: null,
          modelProviderCredentialScope: null,
          modelProviderId: null,
          modelProviderType: null,
          selectedModel: "deepseek-v4-flash",
          updatedAt: "2026-08-02 00:00:00",
        },
        {
          codexServiceTier: null,
          modelProviderCredentialScope: null,
          modelProviderId: null,
          modelProviderType: null,
          selectedModel: "deepseek-v4-flash",
          updatedAt: "2026-08-03 00:00:00",
        },
        {
          codexServiceTier: "priority",
          modelProviderCredentialScope: "org",
          modelProviderId: null,
          modelProviderType: "openai-api-key",
          selectedModel: "gpt-5.5",
          updatedAt: "2026-08-04 00:00:00",
        },
        {
          codexServiceTier: null,
          modelProviderCredentialScope: "org",
          modelProviderId: "00000000-0000-4000-8000-000000090511",
          modelProviderType: "anthropic-api-key",
          selectedModel: "claude-sonnet-4-6",
          updatedAt: "2026-08-05 00:00:00",
        },
      ]);

      const agents = await client.query<{
        modelProviderId: string | null;
        selectedModel: string;
      }>(`
        SELECT
          "selected_model" AS "selectedModel",
          "model_provider_id"::text AS "modelProviderId"
        FROM "zero_agents"
        ORDER BY "id"
      `);
      assert.deepEqual(agents.rows, [
        {
          modelProviderId: "00000000-0000-4000-8000-000000090511",
          selectedModel: "claude-opus-4-8",
        },
        {
          modelProviderId: null,
          selectedModel: "deepseek-v4-flash",
        },
        {
          modelProviderId: null,
          selectedModel: "deepseek-v4-flash",
        },
      ]);

      const providers = await client.query<{
        id: string;
        isDefault: boolean;
        selectedModel: string;
        type: string;
      }>(`
        SELECT
          "id"::text AS "id",
          "type",
          "is_default" AS "isDefault",
          "selected_model" AS "selectedModel"
        FROM "model_providers"
        ORDER BY "id"
      `);
      assert.deepEqual(providers.rows, [
        {
          id: "00000000-0000-4000-8000-000000090511",
          isDefault: true,
          selectedModel: "anthropic/claude-opus-4.8",
          type: "anthropic-api-key",
        },
        {
          id: "00000000-0000-4000-8000-000000090513",
          isDefault: true,
          selectedModel: "deepseek-v4-flash",
          type: "vm0",
        },
        {
          id: "00000000-0000-4000-8000-000000090515",
          isDefault: true,
          selectedModel: "deepseek-v4-flash",
          type: "vm0",
        },
        {
          id: "00000000-0000-4000-8000-000000090517",
          isDefault: true,
          selectedModel: "deepseek-v4-flash",
          type: "vm0",
        },
      ]);

      const secretNames = await client.query<{ name: string }>(`
        SELECT "name"
        FROM "secrets"
        ORDER BY "name"
      `);
      assert.deepEqual(secretNames.rows, [
        { name: "anthropic-retained" },
        { name: "unrelated-retained" },
      ]);

      const historicalRun = await client.query<{
        modelProviderId: string;
        selectedModel: string;
      }>(`
        SELECT
          "model_provider_id"::text AS "modelProviderId",
          "selected_model" AS "selectedModel"
        FROM "zero_runs"
        WHERE "id" = '00000000-0000-4000-8000-000000090561'
      `);
      assert.deepEqual(historicalRun.rows, [
        {
          modelProviderId: "00000000-0000-4000-8000-000000090512",
          selectedModel: "kimi-k3",
        },
      ]);

      const historicalEvent = await client.query<{ content: string }>(`
        SELECT "content"
        FROM "chat_events"
        WHERE "id" = '00000000-0000-4000-8000-000000090571'
      `);
      assert.deepEqual(historicalEvent.rows, [
        { content: "Historical claude-opus-4-7 display payload" },
      ]);

      const pricing = await client.query<{
        kind: string;
        provider: string;
      }>(`
        SELECT "kind", "provider"
        FROM "usage_pricing"
        WHERE "id" IN (
          '00000000-0000-4000-8000-000000090581',
          '00000000-0000-4000-8000-000000090582',
          '00000000-0000-4000-8000-000000090583',
          '00000000-0000-4000-8000-000000090584',
          '00000000-0000-4000-8000-000000090585',
          '00000000-0000-4000-8000-000000090586'
        )
        ORDER BY "kind", "provider"
      `);
      assert.deepEqual(pricing.rows, [
        { kind: "image-recognition", provider: "xiaomi/mimo-v2.5" },
        { kind: "model", provider: "claude-sonnet-4-6" },
        { kind: "model", provider: "gpt-5.5" },
      ]);
    };

    await assertMigratedState();

    const migrationSql = await fs.readFile(
      path.join(
        MIGRATIONS_DIR,
        `${FINALIZE_INACTIVE_RUN_MODELS_MIGRATION}.sql`,
      ),
      "utf8",
    );
    await client.query(migrationSql);
    await assertMigratedState();

    console.log("   ✅ reopened models regain non-default workspace policies");
    console.log(
      "   ✅ aggressive thread pins and direct agent routes converge eagerly",
    );
    console.log(
      "   ✅ incompatible direct providers transfer defaults and are removed",
    );
    console.log(
      "   ✅ reopened models, historical rows, and task pricing stay intact",
    );
    console.log("   ✅ rerunning the data migration is idempotent\n");
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

const CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_PREVIOUS_MIGRATION =
  "0914_loud_magdalene";
const CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_MIGRATION =
  "0915_canonicalize_custom_connector_secret_placeholders";

async function validateCustomConnectorSecretPlaceholderCanonicalization(): Promise<void> {
  console.log(
    "=== Validate Custom Connector secret placeholder canonicalization ===\n",
  );
  const testDb = "migration_custom_connector_secret_placeholder_test";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const validConnectorId = "26669000-0000-4000-8000-000000000001";
  const invalidConnectorId = "26669000-0000-4000-8000-000000000002";
  const overflowConnectorId = "26669000-0000-4000-8000-000000000003";
  const fields = [
    {
      key: "secret",
      label: "Secret",
      kind: "secret",
      required: true,
      description: "Primary credential",
    },
    {
      key: "region",
      label: "Region",
      kind: "variable",
      required: false,
    },
  ];
  const legacyHeaderInjections = [
    {
      name: "Authorization",
      valueTemplate:
        "Bearer {{secret}}/{{secrets.secret}}/{{secret}}/{{variables.region}}",
      metadata: { preserve: true },
    },
    {
      name: "X-Canonical",
      valueTemplate: "{{secrets.secret}}",
      untouched: "header",
    },
  ];
  const legacyQueryInjections = [
    {
      name: "token",
      valueTemplate: "{{secret}}:{{variables.region}}",
      priority: 1,
    },
    {
      name: "canonical",
      valueTemplate: "{{secrets.secret}}",
      untouched: "query",
    },
  ];
  const canonicalHeaderInjections = [
    {
      name: "Authorization",
      valueTemplate:
        "Bearer {{secrets.secret}}/{{secrets.secret}}/{{secrets.secret}}/{{variables.region}}",
      metadata: { preserve: true },
    },
    {
      name: "X-Canonical",
      valueTemplate: "{{secrets.secret}}",
      untouched: "header",
    },
  ];
  const canonicalQueryInjections = [
    {
      name: "token",
      valueTemplate: "{{secrets.secret}}:{{variables.region}}",
      priority: 1,
    },
    {
      name: "canonical",
      valueTemplate: "{{secrets.secret}}",
      untouched: "query",
    },
  ];

  try {
    await applyMigrationsUpToTag(
      client,
      CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_PREVIOUS_MIGRATION,
    );

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "auth_mode",
          "enabled",
          "permission_bundle_ref",
          "storage_version",
          "created_by",
          "created_at",
          "updated_at"
        ) VALUES (
          $1,
          'issue-26669-org',
          '_legacy-secret-valid',
          'Legacy Secret Valid',
          '["https://api.example.test/"]'::jsonb,
          $2::jsonb,
          $3::jsonb,
          $4::jsonb,
          'manual',
          false,
          'builtin:issue-26669@1',
          37,
          'issue-26669-user',
          '2026-08-13 01:02:03',
          '2026-08-13 04:05:06'
        )
      `,
      [
        validConnectorId,
        JSON.stringify(fields),
        JSON.stringify(legacyHeaderInjections),
        JSON.stringify(legacyQueryInjections),
      ],
    );
    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "auth_mode",
          "created_by"
        ) VALUES (
          $1,
          'issue-26669-org',
          '_legacy-secret-ambiguous',
          'Legacy Secret Ambiguous',
          '["https://ambiguous.example.test/"]'::jsonb,
          $2::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secret}}"}]'::jsonb,
          '[]'::jsonb,
          'manual',
          'issue-26669-user'
        )
      `,
      [
        invalidConnectorId,
        JSON.stringify([fields[0], { ...fields[0], label: "Duplicate" }]),
      ],
    );

    await assert.rejects(
      applyMigrationsUpToTag(
        client,
        CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_MIGRATION,
      ),
      /ambiguous secret field data/u,
    );
    const rolledBack = await client.query<{
      headerInjections: unknown;
      queryInjections: unknown;
    }>(
      `
        SELECT
          "header_injections" AS "headerInjections",
          "query_injections" AS "queryInjections"
        FROM "org_custom_connectors"
        WHERE "id" = $1
      `,
      [validConnectorId],
    );
    assert.deepEqual(rolledBack.rows, [
      {
        headerInjections: legacyHeaderInjections,
        queryInjections: legacyQueryInjections,
      },
    ]);

    await client.query(`DELETE FROM "org_custom_connectors" WHERE "id" = $1`, [
      invalidConnectorId,
    ]);

    const utf16BoundaryTemplate = `${"😀".repeat(1019)}{{secret}}`;
    assert.equal(utf16BoundaryTemplate.length, 2048);
    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "auth_mode",
          "created_by"
        ) VALUES (
          $1,
          'issue-26669-org',
          '_legacy-secret-overflow',
          'Legacy Secret Overflow',
          '["https://overflow.example.test/"]'::jsonb,
          $2::jsonb,
          $3::jsonb,
          '[]'::jsonb,
          'manual',
          'issue-26669-user'
        )
      `,
      [
        overflowConnectorId,
        JSON.stringify(fields),
        JSON.stringify([
          { name: "Authorization", valueTemplate: utf16BoundaryTemplate },
        ]),
      ],
    );
    await assert.rejects(
      applyMigrationsUpToTag(
        client,
        CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_MIGRATION,
      ),
      /exceeds canonical limit/u,
    );
    const overflowRolledBack = await client.query<{
      valueTemplate: string;
    }>(
      `
        SELECT "entry"."injection" ->> 'valueTemplate' AS "valueTemplate"
        FROM "org_custom_connectors" AS "connector"
        CROSS JOIN LATERAL jsonb_array_elements(
          "connector"."header_injections"
        ) AS "entry"("injection")
        WHERE "connector"."id" = $1
      `,
      [overflowConnectorId],
    );
    assert.deepEqual(overflowRolledBack.rows, [
      { valueTemplate: utf16BoundaryTemplate },
    ]);

    await client.query(`DELETE FROM "org_custom_connectors" WHERE "id" = $1`, [
      overflowConnectorId,
    ]);
    await applyMigrationsUpToTag(
      client,
      CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_MIGRATION,
    );

    const readMigratedFixture = async (): Promise<readonly unknown[]> => {
      const result = await client.query<{
        createdAt: string;
        displayName: string;
        enabled: boolean;
        headerInjections: unknown;
        permissionBundleRef: string;
        queryInjections: unknown;
        storageVersion: string;
        updatedAt: string;
      }>(
        `
          SELECT
            "display_name" AS "displayName",
            "header_injections" AS "headerInjections",
            "query_injections" AS "queryInjections",
            "enabled",
            "permission_bundle_ref" AS "permissionBundleRef",
            "storage_version"::text AS "storageVersion",
            to_char("created_at", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
            to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
          FROM "org_custom_connectors"
          WHERE "id" = $1
        `,
        [validConnectorId],
      );
      return result.rows;
    };
    const expectedMigratedFixture = [
      {
        displayName: "Legacy Secret Valid",
        headerInjections: canonicalHeaderInjections,
        queryInjections: canonicalQueryInjections,
        enabled: false,
        permissionBundleRef: "builtin:issue-26669@1",
        storageVersion: "37",
        createdAt: "2026-08-13 01:02:03",
        updatedAt: "2026-08-13 04:05:06",
      },
    ];
    assert.deepEqual(await readMigratedFixture(), expectedMigratedFixture);

    const residual = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count"
      FROM "org_custom_connectors" AS "connector"
      CROSS JOIN LATERAL (
        SELECT "entry"."injection"
        FROM jsonb_array_elements("connector"."header_injections")
          AS "entry"("injection")
        UNION ALL
        SELECT "entry"."injection"
        FROM jsonb_array_elements("connector"."query_injections")
          AS "entry"("injection")
      ) AS "entry"
      WHERE jsonb_typeof("entry"."injection" -> 'valueTemplate') = 'string'
        AND strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
    `);
    assert.deepEqual(residual.rows, [{ count: 0 }]);

    const migrationSql = await fs.readFile(
      path.join(
        MIGRATIONS_DIR,
        `${CUSTOM_CONNECTOR_SECRET_PLACEHOLDER_MIGRATION}.sql`,
      ),
      "utf8",
    );
    await client.query(migrationSql);
    assert.deepEqual(await readMigratedFixture(), expectedMigratedFixture);

    console.log("   ✅ ambiguous matching data aborts without partial writes");
    console.log(
      "   ✅ canonical UTF-16 overflows abort without partial writes",
    );
    console.log(
      "   ✅ header and query templates canonicalize exactly in order",
    );
    console.log("   ✅ unrelated JSON and connector metadata stay unchanged");
    console.log(
      "   ✅ zero legacy expressions remain and reruns are idempotent\n",
    );
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

async function validateUsagePackPendingSnapshotSerializationMigration(): Promise<void> {
  console.log(
    "=== Phase 1.30: Validate usage-pack pending snapshot serialization ===\n",
  );
  const testDb = "migration_test_usage_pack_pending_serialization";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  const competingClient = new Client({
    connectionString: createTestDbUrl(testDb),
  });
  await client.connect();
  await competingClient.connect();

  const firstId = "00000000-0000-4000-8000-000000002831";
  const secondId = "00000000-0000-4000-8000-000000002832";
  const replacementId = "00000000-0000-4000-8000-000000002833";
  const orgId = "org_usage_pack_pending_serialization_28304";
  try {
    await applyMigrationsUpToTag(client, "0951_cool_bill_hollister");
    await client.query(
      `
        INSERT INTO "usage_pack_subscriptions" (
          "id",
          "org_id",
          "tier",
          "stripe_plan_price_id",
          "stripe_customer_id",
          "stripe_checkout_session_id",
          "subscription_status",
          "updated_at"
        )
        VALUES
          ($1, $3, 'pro', 'price_plan', 'cus_dirty', 'cs_dirty_first', 'checkout_pending', '2026-08-20 00:00:00'),
          ($2, $3, 'pro', 'price_plan', 'cus_dirty', 'cs_dirty_second', 'checkout_pending', '2026-08-20 00:01:00')
      `,
      [firstId, secondId, orgId],
    );

    await applyMigrationsUpToTag(client, "0954_icy_bulldozer");
    const seededGuards = await client.query<{
      orgId: string;
      pendingSnapshotCount: number;
    }>(
      `
        SELECT
          "org_id" AS "orgId",
          "pending_snapshot_count" AS "pendingSnapshotCount"
        FROM "usage_pack_pending_snapshot_guards"
        WHERE "org_id" = $1
      `,
      [orgId],
    );
    assert.deepEqual(seededGuards.rows, [{ orgId, pendingSnapshotCount: 2 }]);

    await assert.rejects(
      client.query(
        `
          INSERT INTO "usage_pack_subscriptions" (
            "id",
            "org_id",
            "tier",
            "stripe_plan_price_id",
            "stripe_customer_id",
            "subscription_status"
          )
          VALUES ($1, $2, 'pro', 'price_plan', 'cus_dirty', 'purchase_pending')
        `,
        [replacementId, orgId],
      ),
      (error: unknown) => {
        return (
          typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "code") === "23505" &&
          Reflect.get(error, "constraint") ===
            "uq_usage_pack_subscriptions_pending_org"
        );
      },
    );

    await Promise.all([
      client.query(
        `UPDATE "usage_pack_subscriptions" SET "subscription_status" = 'checkout_expired' WHERE "id" = $1`,
        [secondId],
      ),
      competingClient.query(
        `UPDATE "usage_pack_subscriptions" SET "subscription_status" = 'checkout_expired' WHERE "id" = $1`,
        [firstId],
      ),
    ]);
    const reconciledGuards = await client.query<{
      pendingSnapshotCount: number;
    }>(
      `SELECT "pending_snapshot_count" AS "pendingSnapshotCount" FROM "usage_pack_pending_snapshot_guards" WHERE "org_id" = $1`,
      [orgId],
    );
    assert.deepEqual(reconciledGuards.rows, [{ pendingSnapshotCount: 0 }]);

    await client.query(
      `
        INSERT INTO "usage_pack_subscriptions" (
          "id",
          "org_id",
          "tier",
          "stripe_plan_price_id",
          "stripe_customer_id",
          "subscription_status"
        )
        VALUES ($1, $2, 'pro', 'price_plan', 'cus_dirty', 'purchase_pending')
      `,
      [replacementId, orgId],
    );
    const replacementGuards = await client.query<{
      pendingSnapshotCount: number;
    }>(
      `SELECT "pending_snapshot_count" AS "pendingSnapshotCount" FROM "usage_pack_pending_snapshot_guards" WHERE "org_id" = $1`,
      [orgId],
    );
    assert.deepEqual(replacementGuards.rows, [{ pendingSnapshotCount: 1 }]);

    console.log(
      "   ✅ Dirty pre-0954 snapshots retain their exact pending count",
    );
    console.log(
      "   ✅ Concurrent reconciliation reaches zero before replacement\n",
    );
  } finally {
    await competingClient.end();
    await client.end();
    await dropDatabase(testDb);
  }
}

async function main(): Promise<void> {
  console.log("🧪 Testing Migration Consistency (Schema Comparison)\n");

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";
  let migrationsBackedUp = false;

  try {
    // Step 0: Validate snapshot files
    await validateSnapshotFiles();

    // Step 0.1: Validate transition validators use migration tags
    await validateMigrationTagReferences();

    // Step 0.5: Validate timestamp ordering
    await validateTimestampOrdering();

    await validateIntegrationUserIdContractMigration();
    await validateRunEventSequenceNumberRollout();
    await validateGoalOnlyRunGroupsCleanup();
    await validateTeamsMessageFileScopeBackfill();
    await validateInvalidatedGoalContinuationCleanup();
    await validateMcpCustomConnectorReaderPreparation();
    await validateCustomConnectorDefinitionContraction();
    await validateChatEventContractCutover();
    await validateChatEventContractionPreparation();
    await validateChatEventContractionFinalization();
    await validateCanonicalChatEventStorageBackfill();
    await validateChatEventPhysicalContraction();
    await validateChatRunServiceTierAnnotationBackfill();
    await validateUsagePackInviteLifecycleMigrations();
    await validateRetiredRunModelStateMigration();
    await validateConnectionScopedVariableUniqueness();
    await validateInactiveRunModelFinalization();
    await validateCustomConnectorSecretPlaceholderCanonicalization();
    await validateAgentRunMetadataStage2Preflight();
    await validateAgentRunMetadataStage2Lock();
    await validateAgentRunMetadataStage2Index();
    await validateAgentRunMetadataStage2Final();
    await validateAgentRunMetadataStage2Runner();
    await validateAgentRunLaunchSnapshotMigration();
    await validateOfficialAutomationResultEmailMigration();
    await validateFeishuConnectorOwnershipCleanup();
    await validateConnectorAccountExpansion();
    await validateConnectorAuthorizationAccountMutationPresence();
    await validateFeishuMemberConnectorReconciliation();
    await validateCustomGatewayProviderTypes();
    await validateUsagePackPendingSnapshotSerializationMigration();
    await validateOkouDebugFeatureSwitchKeyRename();
    await validateSlackOfficialBrandMigration();
    await validateAgentDraftsCompatibilityRelation();
    await validateChatSearchDeleteCompatibility(dbUrl.toString());
    await validateWorkflowCompatibilityViews();
    await validateBuiltInProviderDiscriminatorMigration(dbUrl.toString());
    await validateOrgMetadataAcquisitionFirstPartySourceExpansion(
      dbUrl.toString(),
    );
    await validateOrgMetadataAcquisitionFirstPartySourceBackfill(
      dbUrl.toString(),
    );
    await validateOrgPlanEntitlementRestrictionExpansion(dbUrl.toString());
    await validateOrgPlanEntitlementRestrictionBackfill(dbUrl.toString());
    await validateOrgPlanEntitlementRestrictionNotNull(dbUrl.toString());

    // Step 1.5: Validate latest snapshot accuracy (NEW)
    await validateLatestSnapshotAccuracy();

    // Step 1: Test with existing migrations
    console.log("=== Phase 2: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Migrations applied successfully\n");

    console.log("=== Phase 2.1: Validate database reset ===\n");
    await resetDatabase(dbUrl1);
    await resetDatabase(dbUrl1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Consecutive database resets completed successfully\n");

    await validateCanonicalIntegrationIdentitySchema(dbUrl1);
    await validatePermanentAgentRunBuiltInModelKeyState(dbUrl1);
    await validatePermanentTriggerAndFunctionInventory(dbUrl1);
    await validatePermanentOrgMetadataAcquisitionFirstPartySourceState(dbUrl1);
    await validatePermanentOrgPlanEntitlementRestrictionState(dbUrl1);
    await validatePermanentBuiltInProviderDiscriminatorState(dbUrl1);
    await validateActiveLegacyDatabaseIdentityInventory(dbUrl1);
    await validatePermanentArtifactTriggerBehavior(dbUrl1);
    await validatePermanentAgentRunMetadataState(dbUrl1);
    await validatePermanentBuiltInModelCooldownState(dbUrl1);
    await validatePermanentBuiltInModelKeyState(dbUrl1);
    await validatePermanentSlackPublicBrandState(dbUrl1);
    await validateAgentRunLaunchSnapshotSchema(dbUrl1);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl1);
    await validateOfficialAutomationResultEmailSchema(dbUrl1);
    await validateExpandedBrowserSchema(dbUrl1);
    await validateChatEventSourcesAreAppendOnly(dbUrl1);
    await validateChatEventContextPointerConstraints(dbUrl1);
    await validateConnectorCatalogFinalConstraints(dbUrl1);
    await validateCustomConnectorOauthModeConstraints(dbUrl1);
    await validateCustomConnectorSkillVersionPair(dbUrl1);

    // Step 2: Backup and regenerate migrations
    console.log("=== Phase 3: Test regenerated migrations ===\n");
    const orgMetadataAcquisitionFirstPartySourceMigrationSql =
      await fs.readFile(
        path.join(
          MIGRATIONS_DIR,
          `${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION}.sql`,
        ),
        "utf8",
      );
    const orgMetadataAcquisitionFirstPartySourceBackfillMigrationSql =
      await fs.readFile(
        path.join(
          MIGRATIONS_DIR,
          `${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_MIGRATION}.sql`,
        ),
        "utf8",
      );
    const orgPlanEntitlementRestrictionMigrationSql = await fs.readFile(
      path.join(
        MIGRATIONS_DIR,
        `${ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION}.sql`,
      ),
      "utf8",
    );
    const orgPlanEntitlementRestrictionBackfillMigrationSql = await fs.readFile(
      path.join(
        MIGRATIONS_DIR,
        `${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_MIGRATION}.sql`,
      ),
      "utf8",
    );
    await backupMigrations();
    migrationsBackedUp = true;
    await generateFreshMigrations();

    // Step 3: Test with regenerated migrations
    await createDatabase(TEST_DB_2);
    const dbUrl2 = createTestDbUrl(TEST_DB_2);
    await runMigrations(dbUrl2);
    console.log("   ✅ Fresh migrations applied successfully\n");
    await installOrgMetadataAcquisitionFirstPartySourceArtifactsOnRegeneratedSchema(
      dbUrl2,
      orgMetadataAcquisitionFirstPartySourceMigrationSql,
    );
    await validateOrgMetadataAcquisitionFirstPartySourceBackfillOnRegeneratedSchema(
      dbUrl2,
      orgMetadataAcquisitionFirstPartySourceBackfillMigrationSql,
    );
    await installOrgPlanEntitlementRestrictionArtifactsOnRegeneratedSchema(
      dbUrl2,
      orgPlanEntitlementRestrictionMigrationSql,
    );
    await validateOrgPlanEntitlementRestrictionBackfillOnRegeneratedSchema(
      dbUrl2,
      orgPlanEntitlementRestrictionBackfillMigrationSql,
    );
    await validatePermanentOrgMetadataAcquisitionFirstPartySourceState(dbUrl2);
    await validatePermanentOrgPlanEntitlementRestrictionState(dbUrl2);
    await validatePermanentAgentRunBuiltInModelKeyState(dbUrl2);
    await validatePermanentBuiltInModelCooldownState(dbUrl2);
    await validatePermanentBuiltInModelKeyState(dbUrl2);
    await validatePermanentSlackPublicBrandState(dbUrl2);
    await validateAgentRunLaunchSnapshotSchema(dbUrl2);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl2);
    await validateOfficialAutomationResultEmailSchema(dbUrl2);

    // Step 4: Restore original migrations
    await restoreMigrations();
    migrationsBackedUp = false;

    // Step 5: Run normalized comparison (using pg library)
    console.log("=== Phase 4: Normalized schema comparison ===\n");
    const comparisonPassed = await runNormalizedComparison(dbUrl1, dbUrl2);

    if (comparisonPassed) {
      console.log("\n✅ SUCCESS: All validations passed!");
      console.log("   ✅ Snapshot count matches migration count");
      console.log("   ✅ Snapshot chain is intact (id/prevId references)");
      console.log("   ✅ Journal timestamps are strictly increasing");
      console.log("   ✅ Latest snapshot accurately reflects final DB state");
      console.log(
        "   ✅ Browser state uses canonical thread identity and lifecycle events",
      );
      console.log("   ✅ Chat event source tables reject UPDATE");
      console.log(
        "   ✅ Final connector catalog constraints reject invalid state",
      );
      console.log(
        "   ✅ Custom connector OAuth mode constraints reject mismatched configuration",
      );
      console.log(
        "   ✅ Custom connector skill columns reject mixed version state",
      );
      console.log("   ✅ Legacy Teams message file scope is backfilled");
      console.log(
        "   ✅ Zero-run Codex tier readers survive the pre-expansion schema",
      );
      console.log(
        "   ✅ Old run creation paths synchronize metadata into agent_runs",
      );
      console.log("   ✅ Agent-run model-key canonical schemas match");
      console.log(
        "   ✅ Org plan restriction expansion, backfill, NOT NULL, and mirror invariants match",
      );
      console.log("   ✅ Permanent trigger and function inventories match");
      console.log(
        "   ✅ Permanent artifact triggers preserve cascade, queue, and scope behavior",
      );
      console.log("   ✅ Draining API avatar writes receive preset defaults");
      console.log("   ✅ Consecutive database resets replay all migrations");
      console.log("   ✅ Schemas are functionally equivalent");
      console.log("   ✅ All migrations match the schema definitions");

      // Cleanup
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);

      process.exit(0);
    } else {
      console.log("\n❌ FAILURE: Schemas have functional differences!");
      console.log(
        `\n   This means the migration files don't match the schema definitions.`,
      );
      console.log(`\n   💡 Databases preserved for analysis:`);
      console.log(`      ${TEST_DB_1}`);
      console.log(`      ${TEST_DB_2}`);
      console.log(`\n   For detailed analysis, run:`);
      console.log(
        `     pnpm -F @okouai/db exec tsx scripts/compare-schemas-normalized.ts "<${TEST_DB_1}-url>" "<${TEST_DB_2}-url>"`,
      );
      console.log(`\n   🔧 How to fix:`);
      console.log(`      1. Check if you manually edited any migration files`);
      console.log(`      2. Reset database: pnpm -F @okouai/db db:reset`);
      console.log(`      3. Delete the problematic migration files`);
      console.log(
        `      4. Remove corresponding entries from meta/_journal.json`,
      );
      console.log(`      5. Delete corresponding snapshots`);
      console.log(`      6. Regenerate: pnpm -F @okouai/db db:generate`);
      console.log(`      7. Apply: pnpm -F @okouai/db db:migrate`);
      console.log(
        `\n   ⚠️  IMPORTANT: Never manually write or edit migration files!`,
      );
      console.log(
        `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
      );
      console.log(
        `      Manual edits break the snapshot system and cause schema mismatches.\n`,
      );

      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Error during test:", error);

    // Try to cleanup
    try {
      if (migrationsBackedUp) {
        await restoreMigrations();
      }
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);
    } catch (cleanupError) {
      console.error("⚠️  Failed to cleanup:", cleanupError);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
