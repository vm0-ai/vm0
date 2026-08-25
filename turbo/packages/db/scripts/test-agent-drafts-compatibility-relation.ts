import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0996_curvy_ben_urich";
const expansionMigration = "0997_agent_drafts_compatibility_relation";
const testDatabase = "migration_agent_drafts_relation";

const parentAgentId = "00000000-0000-4000-8000-000000099701";
const legacyRelation = "zero_agent_drafts";
const canonicalRelation = "agent_drafts";
const relationIdentifiers = {
  [canonicalRelation]: '"agent_drafts"',
  [legacyRelation]: '"zero_agent_drafts"',
} as const;

type RelationName = keyof typeof relationIdentifiers;

interface DraftRow {
  readonly agentId: string;
  readonly createdAt: string;
  readonly draftAttachments: string | null;
  readonly draftUserMessage: string | null;
  readonly orgId: string;
  readonly updatedAt: string;
  readonly userId: string;
}

interface DraftWriteFixture {
  readonly agentId: string;
  readonly draftAttachments: string | null;
  readonly draftUserMessage: string | null;
  readonly orgId: string;
  readonly updatedAt: string;
  readonly userId: string;
}

interface PhysicalObjectDefinition {
  readonly constraintType: string | null;
  readonly definition: string;
  readonly isUnique: boolean | null;
  readonly objectName: string;
  readonly objectType: string;
  readonly referencedRelation: string | null;
  readonly relationName: string;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return databaseErrorCode(error) === code;
  });
}

async function validateMigrationSql(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  const normalizedSql = migrationSql.trim().replace(/\s+/gu, " ");
  assert.equal(
    normalizedSql,
    'CREATE VIEW "agent_drafts" AS SELECT "user_id", "org_id", "agent_id", "draft_user_message", "draft_attachments", "created_at", "updated_at" FROM "zero_agent_drafts";',
  );
}

async function validatePreExpansionCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "relname" AS "relationName",
      "relkind"::text AS "relationKind"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(relations.rows, [
    { relationKind: "r", relationName: legacyRelation },
  ]);
}

async function validateExpandedCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "relname" AS "relationName",
      "relkind"::text AS "relationKind"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(relations.rows, [
    { relationKind: "v", relationName: canonicalRelation },
    { relationKind: "r", relationName: legacyRelation },
  ]);

  const columns = await client.query<{ columnName: string }>(`
    SELECT "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'agent_drafts'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(
    columns.rows.map(({ columnName }) => {
      return columnName;
    }),
    [
      "user_id",
      "org_id",
      "agent_id",
      "draft_user_message",
      "draft_attachments",
      "created_at",
      "updated_at",
    ],
  );

  const viewMetadata = await client.query<{
    isInsertableInto: string;
    isUpdatable: string;
  }>(`
    SELECT
      "is_insertable_into" AS "isInsertableInto",
      "is_updatable" AS "isUpdatable"
    FROM "information_schema"."views"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'agent_drafts'
  `);
  assert.deepEqual(viewMetadata.rows, [
    { isInsertableInto: "YES", isUpdatable: "YES" },
  ]);

  const triggers = await client.query<{ triggerName: string }>(`
    SELECT "tgname" AS "triggerName"
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.agent_drafts'::regclass
      AND NOT "tgisinternal"
  `);
  assert.deepEqual(triggers.rows, []);

  const rules = await client.query<{ ruleName: string }>(`
    SELECT "rulename" AS "ruleName"
    FROM "pg_rewrite"
    WHERE "ev_class" = 'public.agent_drafts'::regclass
    ORDER BY "rulename"
  `);
  assert.deepEqual(rules.rows, [{ ruleName: "_RETURN" }]);
}

async function readPhysicalObjectDefinitions(
  client: Client,
): Promise<PhysicalObjectDefinition[]> {
  const objects = await client.query<PhysicalObjectDefinition>(`
    SELECT
      NULL::text AS "constraintType",
      "pg_get_indexdef"("pg_index"."indexrelid") AS "definition",
      "pg_index"."indisunique" AS "isUnique",
      "index_relation"."relname" AS "objectName",
      'index'::text AS "objectType",
      NULL::text AS "referencedRelation",
      "table_relation"."relname" AS "relationName"
    FROM "pg_index"
    INNER JOIN "pg_class" AS "index_relation"
      ON "index_relation"."oid" = "pg_index"."indexrelid"
    INNER JOIN "pg_class" AS "table_relation"
      ON "table_relation"."oid" = "pg_index"."indrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "table_relation"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "index_relation"."relname" = 'idx_zero_agent_drafts_user_org_agent'

    UNION ALL

    SELECT
      "pg_constraint"."contype"::text AS "constraintType",
      "pg_get_constraintdef"("pg_constraint"."oid", true) AS "definition",
      NULL::boolean AS "isUnique",
      "pg_constraint"."conname" AS "objectName",
      'constraint'::text AS "objectType",
      CASE
        WHEN "pg_constraint"."confrelid" = 0 THEN NULL
        ELSE "pg_constraint"."confrelid"::regclass::text
      END AS "referencedRelation",
      "table_relation"."relname" AS "relationName"
    FROM "pg_constraint"
    INNER JOIN "pg_class" AS "table_relation"
      ON "table_relation"."oid" = "pg_constraint"."conrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "table_relation"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_constraint"."conname" IN (
        'zero_agent_drafts_agent_id_agents_id_fk',
        'zero_agent_drafts_draft_user_message_check'
      )

    ORDER BY "objectName"
  `);
  return objects.rows;
}

function validatePhysicalObjectDefinitions(
  objects: PhysicalObjectDefinition[],
): void {
  assert.deepEqual(
    objects.map(({ objectName }) => {
      return objectName;
    }),
    [
      "idx_zero_agent_drafts_user_org_agent",
      "zero_agent_drafts_agent_id_agents_id_fk",
      "zero_agent_drafts_draft_user_message_check",
    ],
  );
  assert.ok(
    objects.every(({ relationName }) => {
      return relationName === legacyRelation;
    }),
  );

  const [uniqueIndex, foreignKey, contentCheck] = objects;
  assert.deepEqual(
    {
      isUnique: uniqueIndex?.isUnique,
      objectType: uniqueIndex?.objectType,
    },
    { isUnique: true, objectType: "index" },
  );
  assert.deepEqual(
    {
      constraintType: foreignKey?.constraintType,
      referencedRelation: foreignKey?.referencedRelation,
    },
    { constraintType: "f", referencedRelation: "agents" },
  );
  assert.match(foreignKey?.definition ?? "", /ON DELETE CASCADE$/u);
  assert.equal(contentCheck?.constraintType, "c");
}

async function seedPreExpansionRow(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, $4)
    `,
    [parentAgentId, "historical-org", "historical-owner", "draft-parent"],
  );
  await client.query(
    `
      INSERT INTO "zero_agent_drafts" (
        "user_id",
        "org_id",
        "agent_id",
        "draft_user_message",
        "draft_attachments",
        "created_at",
        "updated_at"
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamp, $7::timestamp)
    `,
    [
      "historical-user",
      "historical-org",
      parentAgentId,
      '{"version":1,"parts":[{"type":"text","text":"historical draft"}]}',
      "[]",
      "2026-08-25 00:00:00.123456",
      "2026-08-25 00:05:00.654321",
    ],
  );
}

async function selectDraft(
  client: Client,
  relation: RelationName,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<DraftRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<DraftRow>(
    `
      SELECT
        "user_id" AS "userId",
        "org_id" AS "orgId",
        "agent_id"::text AS "agentId",
        "draft_user_message"::text AS "draftUserMessage",
        "draft_attachments"::text AS "draftAttachments",
        "created_at"::text AS "createdAt",
        "updated_at"::text AS "updatedAt"
      FROM ${relationIdentifier}
      WHERE "user_id" = $1
        AND "org_id" = $2
        AND "agent_id" = $3
    `,
    [userId, orgId, agentId],
  );
  return result.rows;
}

async function validateHistoricalRow(client: Client): Promise<void> {
  const legacyRows = await selectDraft(
    client,
    legacyRelation,
    "historical-user",
    "historical-org",
    parentAgentId,
  );
  const canonicalRows = await selectDraft(
    client,
    canonicalRelation,
    "historical-user",
    "historical-org",
    parentAgentId,
  );
  assert.equal(legacyRows.length, 1);
  assert.deepEqual(canonicalRows, legacyRows);

  const counts = await client.query<{
    canonicalCount: string;
    physicalCount: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM "agent_drafts") AS "canonicalCount",
      (SELECT count(*)::text FROM "zero_agent_drafts") AS "physicalCount"
  `);
  assert.deepEqual(counts.rows, [{ canonicalCount: "1", physicalCount: "1" }]);
}

async function validateCrossRelationLock(
  client: Client,
  databaseUrl: string,
  lockingRelation: RelationName,
  competingRelation: RelationName,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<void> {
  const lockingIdentifier = relationIdentifiers[lockingRelation];
  const competingIdentifier = relationIdentifiers[competingRelation];
  const contender = new Client({ connectionString: databaseUrl });
  await contender.connect();

  await client.query("BEGIN");
  try {
    const lockedRows = await client.query<{ agentId: string }>(
      `
        SELECT "agent_id"::text AS "agentId"
        FROM ${lockingIdentifier}
        WHERE "user_id" = $1
          AND "org_id" = $2
          AND "agent_id" = $3
        FOR UPDATE
      `,
      [userId, orgId, agentId],
    );
    assert.deepEqual(lockedRows.rows, [{ agentId }]);

    await contender.query("BEGIN");
    await contender.query("SET LOCAL lock_timeout = '100ms'");
    await expectDatabaseFailure(
      contender.query(
        `
          UPDATE ${competingIdentifier}
          SET "updated_at" = $1::timestamp
          WHERE "user_id" = $2
            AND "org_id" = $3
            AND "agent_id" = $4
        `,
        ["2026-08-26 02:00:00", userId, orgId, agentId],
      ),
      "55P03",
    );
  } finally {
    await client.query("ROLLBACK");
    await contender.query("ROLLBACK");
    await contender.end();
  }
}

async function insertDraftWithDefaults(
  client: Client,
  relation: RelationName,
  userId: string,
  orgId: string,
  agentId: string,
  draftUserMessage: string,
): Promise<DraftRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<DraftRow>(
    `
      INSERT INTO ${relationIdentifier} (
        "user_id",
        "org_id",
        "agent_id",
        "draft_user_message",
        "draft_attachments"
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      RETURNING
        "user_id" AS "userId",
        "org_id" AS "orgId",
        "agent_id"::text AS "agentId",
        "draft_user_message"::text AS "draftUserMessage",
        "draft_attachments"::text AS "draftAttachments",
        "created_at"::text AS "createdAt",
        "updated_at"::text AS "updatedAt"
    `,
    [userId, orgId, agentId, draftUserMessage, "[]"],
  );
  return result.rows;
}

async function updateDraft(
  client: Client,
  relation: RelationName,
  userId: string,
  orgId: string,
  agentId: string,
  draftUserMessage: string,
): Promise<DraftRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<DraftRow>(
    `
      UPDATE ${relationIdentifier}
      SET
        "draft_user_message" = $1::jsonb,
        "draft_attachments" = $2::jsonb,
        "updated_at" = $3::timestamp
      WHERE "user_id" = $4
        AND "org_id" = $5
        AND "agent_id" = $6
      RETURNING
        "user_id" AS "userId",
        "org_id" AS "orgId",
        "agent_id"::text AS "agentId",
        "draft_user_message"::text AS "draftUserMessage",
        "draft_attachments"::text AS "draftAttachments",
        "created_at"::text AS "createdAt",
        "updated_at"::text AS "updatedAt"
    `,
    [draftUserMessage, "[]", "2026-08-26 01:00:00", userId, orgId, agentId],
  );
  return result.rows;
}

async function deleteDraft(
  client: Client,
  relation: RelationName,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<DraftRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<DraftRow>(
    `
      DELETE FROM ${relationIdentifier}
      WHERE "user_id" = $1
        AND "org_id" = $2
        AND "agent_id" = $3
      RETURNING
        "user_id" AS "userId",
        "org_id" AS "orgId",
        "agent_id"::text AS "agentId",
        "draft_user_message"::text AS "draftUserMessage",
        "draft_attachments"::text AS "draftAttachments",
        "created_at"::text AS "createdAt",
        "updated_at"::text AS "updatedAt"
    `,
    [userId, orgId, agentId],
  );
  return result.rows;
}

async function validateStatementShapes(
  client: Client,
  databaseUrl: string,
  relation: RelationName,
  counterpart: RelationName,
): Promise<void> {
  const userId = `${relation}-statement-user`;
  const orgId = `${relation}-statement-org`;
  const initialMessage = `{"version":1,"parts":[{"type":"text","text":"${relation} initial"}]}`;
  const insertedRows = await insertDraftWithDefaults(
    client,
    relation,
    userId,
    orgId,
    parentAgentId,
    initialMessage,
  );
  assert.equal(insertedRows.length, 1);
  const [insertedRow] = insertedRows;
  assert.ok(insertedRow);
  assert.ok(insertedRow.createdAt.length > 0);
  assert.ok(insertedRow.updatedAt.length > 0);
  assert.deepEqual(
    await selectDraft(client, counterpart, userId, orgId, parentAgentId),
    insertedRows,
  );

  const updatedMessage = `{"version":1,"parts":[{"type":"text","text":"${relation} updated"}]}`;
  const updatedRows = await updateDraft(
    client,
    relation,
    userId,
    orgId,
    parentAgentId,
    updatedMessage,
  );
  assert.equal(updatedRows.length, 1);
  const [updatedRow] = updatedRows;
  assert.ok(updatedRow);
  assert.equal(updatedRow.createdAt, insertedRow.createdAt);
  assert.deepEqual(
    await selectDraft(client, counterpart, userId, orgId, parentAgentId),
    updatedRows,
  );

  await validateCrossRelationLock(
    client,
    databaseUrl,
    relation,
    counterpart,
    userId,
    orgId,
    parentAgentId,
  );

  const deletedRows = await deleteDraft(
    client,
    relation,
    userId,
    orgId,
    parentAgentId,
  );
  assert.deepEqual(deletedRows, updatedRows);
  assert.deepEqual(
    await selectDraft(client, counterpart, userId, orgId, parentAgentId),
    [],
  );
}

async function persistDraftWithSealedShape(
  client: Client,
  relation: RelationName,
  draft: DraftWriteFixture,
  onFirstMiss?: () => Promise<void>,
): Promise<number> {
  const relationIdentifier = relationIdentifiers[relation];
  let uniqueRetries = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await client.query<{ agentId: string }>(
      `
        UPDATE ${relationIdentifier}
        SET
          "draft_user_message" = $1::jsonb,
          "draft_attachments" = $2::jsonb,
          "updated_at" = $3::timestamp
        WHERE "user_id" = $4
          AND "org_id" = $5
          AND "agent_id" = $6
        RETURNING "agent_id"::text AS "agentId"
      `,
      [
        draft.draftUserMessage,
        draft.draftAttachments,
        draft.updatedAt,
        draft.userId,
        draft.orgId,
        draft.agentId,
      ],
    );
    if (updated.rows.length > 0) {
      return uniqueRetries;
    }

    if (attempt === 0) {
      await onFirstMiss?.();
    }

    try {
      await client.query(
        `
          INSERT INTO ${relationIdentifier} (
            "user_id",
            "org_id",
            "agent_id",
            "draft_user_message",
            "draft_attachments",
            "updated_at"
          )
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamp)
        `,
        [
          draft.userId,
          draft.orgId,
          draft.agentId,
          draft.draftUserMessage,
          draft.draftAttachments,
          draft.updatedAt,
        ],
      );
      return uniqueRetries;
    } catch (error: unknown) {
      if (databaseErrorCode(error) !== "23505" || attempt === 1) {
        throw error;
      }
      uniqueRetries += 1;
    }
  }

  throw new Error("Agent Draft write attempts exhausted");
}

function firstMissBarrier(participantCount: number): () => Promise<void> {
  let arrivals = 0;
  let release: () => void = () => {
    return undefined;
  };
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals += 1;
    assert.ok(arrivals <= participantCount);
    if (arrivals === participantCount) {
      release();
    }
    await allArrived;
  };
}

async function validateConstraintPropagation(client: Client): Promise<void> {
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "agent_drafts" (
          "user_id",
          "org_id",
          "agent_id",
          "draft_user_message"
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        "missing-agent-user",
        "missing-agent-org",
        "00000000-0000-4000-8000-000000099799",
        '{"version":1,"parts":[{"type":"text","text":"missing parent"}]}',
      ],
    ),
    "23503",
  );

  const invalidWrite: DraftWriteFixture = {
    agentId: parentAgentId,
    draftAttachments:
      '[{"id":"00000000-0000-4000-8000-000000099798","url":"https://cdn.example.com/draft.txt","filename":"draft.txt","contentType":"text/plain","size":1}]',
    draftUserMessage: null,
    orgId: "invalid-check-org",
    updatedAt: "2026-08-26 03:30:00",
    userId: "invalid-check-user",
  };
  await expectDatabaseFailure(
    persistDraftWithSealedShape(client, canonicalRelation, invalidWrite),
    "23514",
  );
  assert.deepEqual(
    await selectDraft(
      client,
      legacyRelation,
      invalidWrite.userId,
      invalidWrite.orgId,
      invalidWrite.agentId,
    ),
    [],
  );
}

async function validateConcurrentFirstWrites(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  const participants = 8;
  const waitForFirstMiss = firstMissBarrier(participants);
  const writers = Array.from({ length: participants }, () => {
    return new Client({ connectionString: databaseUrl });
  });
  await Promise.all(
    writers.map(async (writer) => {
      await writer.connect();
    }),
  );

  const writes = Array.from({ length: participants }, (_, index) => {
    return {
      agentId: parentAgentId,
      draftAttachments: null,
      draftUserMessage: `{"version":1,"parts":[{"type":"text","text":"concurrent draft ${index}"}]}`,
      orgId: "concurrent-org",
      updatedAt: `2026-08-26 03:00:0${index}`,
      userId: "concurrent-user",
    } satisfies DraftWriteFixture;
  });

  try {
    const retryCounts = await Promise.all(
      writers.map(async (writer, index) => {
        const write = writes[index];
        assert.ok(write);
        return persistDraftWithSealedShape(
          writer,
          canonicalRelation,
          write,
          waitForFirstMiss,
        );
      }),
    );
    assert.deepEqual(
      [...retryCounts].sort((left, right) => {
        return left - right;
      }),
      [0, 1, 1, 1, 1, 1, 1, 1],
    );
  } finally {
    await Promise.all(
      writers.map(async (writer) => {
        await writer.end();
      }),
    );
  }

  const canonicalRows = await selectDraft(
    client,
    canonicalRelation,
    "concurrent-user",
    "concurrent-org",
    parentAgentId,
  );
  const legacyRows = await selectDraft(
    client,
    legacyRelation,
    "concurrent-user",
    "concurrent-org",
    parentAgentId,
  );
  assert.equal(canonicalRows.length, 1);
  assert.deepEqual(legacyRows, canonicalRows);
  const concurrentState = await client.query<{
    draftText: string;
    updatedAt: string;
  }>(
    `
      SELECT
        "draft_user_message" #>> '{parts,0,text}' AS "draftText",
        "updated_at"::text AS "updatedAt"
      FROM "agent_drafts"
      WHERE "user_id" = 'concurrent-user'
        AND "org_id" = 'concurrent-org'
        AND "agent_id" = $1
    `,
    [parentAgentId],
  );
  assert.equal(concurrentState.rows.length, 1);
  assert.ok(
    writes.some(({ updatedAt }, index) => {
      const [row] = concurrentState.rows;
      return (
        row?.draftText === `concurrent draft ${index}` &&
        row.updatedAt === updatedAt
      );
    }),
  );
}

export async function validateAgentDraftsCompatibilityRelation(): Promise<void> {
  console.log(
    "=== Validate Agent Draft relation compatibility expansion ===\n",
  );

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  await validateMigrationSql();

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await validatePreExpansionCatalog(client);
    await seedPreExpansionRow(client);
    const physicalObjectsBefore = await readPhysicalObjectDefinitions(client);
    validatePhysicalObjectDefinitions(physicalObjectsBefore);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    await validateExpandedCatalog(client);
    await validateHistoricalRow(client);

    const physicalObjectsAfter = await readPhysicalObjectDefinitions(client);
    validatePhysicalObjectDefinitions(physicalObjectsAfter);
    assert.deepEqual(physicalObjectsAfter, physicalObjectsBefore);

    await validateStatementShapes(
      client,
      testUrl.toString(),
      legacyRelation,
      canonicalRelation,
    );
    await validateStatementShapes(
      client,
      testUrl.toString(),
      canonicalRelation,
      legacyRelation,
    );
    await validateConstraintPropagation(client);
    await validateConcurrentFirstWrites(client, testUrl.toString());

    console.log("   ✅ the legacy table remains the sole physical relation");
    console.log(
      "   ✅ the canonical view exposes exactly seven stable columns",
    );
    console.log("   ✅ historical rows and physical objects remain unchanged");
    console.log(
      "   ✅ both relation names share DML, constraints, locks, defaults, and returning behavior",
    );
    console.log(
      "   ✅ canonical concurrent first writes converge with the sealed bounded retry shape\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentDraftsCompatibilityRelation().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
