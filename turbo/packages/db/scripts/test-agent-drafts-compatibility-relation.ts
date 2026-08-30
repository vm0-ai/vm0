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
const switchMigration = "0998_agent_drafts_physical_switch";
const contractMigration = "1001_contract_legacy_agent_drafts_view";
const testDatabase = "migration_agent_drafts_relation";

const parentAgentId = "00000000-0000-4000-8000-000000099701";
const legacyRelation = "zero_agent_drafts";
const canonicalRelation = "agent_drafts";
const relationIdentifiers = {
  [canonicalRelation]: '"agent_drafts"',
  [legacyRelation]: '"zero_agent_drafts"',
} as const;

type RelationName = keyof typeof relationIdentifiers;

const expectedViewColumns = [
  "user_id",
  "org_id",
  "agent_id",
  "draft_user_message",
  "draft_attachments",
  "created_at",
  "updated_at",
] as const;

const expectedPhysicalColumns = [
  "user_id",
  "org_id",
  "agent_id",
  "draft_attachments",
  "created_at",
  "updated_at",
  "draft_user_message",
] as const;

const physicalObjectNames: Record<
  RelationName,
  {
    readonly contentCheck: string;
    readonly foreignKey: string;
    readonly uniqueIndex: string;
  }
> = {
  [canonicalRelation]: {
    contentCheck: "agent_drafts_draft_user_message_check",
    foreignKey: "agent_drafts_agent_id_agents_id_fk",
    uniqueIndex: "idx_agent_drafts_user_org_agent",
  },
  [legacyRelation]: {
    contentCheck: "zero_agent_drafts_draft_user_message_check",
    foreignKey: "zero_agent_drafts_agent_id_agents_id_fk",
    uniqueIndex: "idx_zero_agent_drafts_user_org_agent",
  },
};

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
  readonly objectOid: string;
  readonly objectType: string;
  readonly referencedRelation: string | null;
  readonly relationName: string;
}

interface RelationIdentity {
  readonly relationKind: string;
  readonly relationName: string;
  readonly relationOid: string;
}

interface PhysicalRelationIdentity extends RelationIdentity {
  readonly relationFileNode: string;
}

interface LegacyViewCatalogIdentity {
  readonly relationOid: string;
  readonly rewriteRuleOid: string;
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
  const expansionSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  assert.equal(
    expansionSql.trim().replace(/\s+/gu, " "),
    'CREATE VIEW "agent_drafts" AS SELECT "user_id", "org_id", "agent_id", "draft_user_message", "draft_attachments", "created_at", "updated_at" FROM "zero_agent_drafts";',
  );

  const switchSql = await fs.readFile(
    path.join(migrationsDirectory, `${switchMigration}.sql`),
    "utf8",
  );
  assert.equal(
    switchSql.trim().replace(/\s+/gu, " "),
    'DROP VIEW "agent_drafts"; --> statement-breakpoint ALTER TABLE "zero_agent_drafts" RENAME TO "agent_drafts"; --> statement-breakpoint ALTER TABLE "agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_agent_id_agents_id_fk" TO "agent_drafts_agent_id_agents_id_fk"; --> statement-breakpoint ALTER TABLE "agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_draft_user_message_check" TO "agent_drafts_draft_user_message_check"; --> statement-breakpoint ALTER INDEX "idx_zero_agent_drafts_user_org_agent" RENAME TO "idx_agent_drafts_user_org_agent"; --> statement-breakpoint CREATE VIEW "zero_agent_drafts" AS SELECT "user_id", "org_id", "agent_id", "draft_user_message", "draft_attachments", "created_at", "updated_at" FROM "agent_drafts";',
  );

  const contractSql = await fs.readFile(
    path.join(migrationsDirectory, `${contractMigration}.sql`),
    "utf8",
  );
  assert.equal(
    contractSql.trim().replace(/\s+/gu, " "),
    'DROP VIEW "zero_agent_drafts";',
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

async function validateCompatibilityCatalog(
  client: Client,
  physicalRelation: RelationName,
  viewRelation: RelationName,
): Promise<RelationIdentity[]> {
  const relations = await client.query<RelationIdentity>(`
    SELECT
      "relname" AS "relationName",
      "relkind"::text AS "relationKind",
      "pg_class"."oid"::text AS "relationOid"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(
    relations.rows.map(({ relationKind, relationName }) => {
      return { relationKind, relationName };
    }),
    [
      { relationKind: "r", relationName: physicalRelation },
      { relationKind: "v", relationName: viewRelation },
    ].sort((left, right) => {
      return left.relationName.localeCompare(right.relationName);
    }),
  );

  for (const relationName of [canonicalRelation, legacyRelation]) {
    const columns = await client.query<{ columnName: string }>(
      `
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = $1
        ORDER BY "ordinal_position"
      `,
      [relationName],
    );
    assert.deepEqual(
      columns.rows.map(({ columnName }) => {
        return columnName;
      }),
      relationName === viewRelation
        ? expectedViewColumns
        : expectedPhysicalColumns,
    );
  }

  const viewMetadata = await client.query<{
    isInsertableInto: string;
    isUpdatable: string;
  }>(
    `
      SELECT
        "is_insertable_into" AS "isInsertableInto",
        "is_updatable" AS "isUpdatable"
      FROM "information_schema"."views"
      WHERE "table_schema" = 'public'
        AND "table_name" = $1
    `,
    [viewRelation],
  );
  assert.deepEqual(viewMetadata.rows, [
    { isInsertableInto: "YES", isUpdatable: "YES" },
  ]);

  const triggers = await client.query<{
    relationName: string;
    triggerName: string;
  }>(`
    SELECT
      "pg_class"."relname" AS "relationName",
      "pg_trigger"."tgname" AS "triggerName"
    FROM "pg_trigger"
    INNER JOIN "pg_class" ON "pg_class"."oid" = "pg_trigger"."tgrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
      AND NOT "pg_trigger"."tgisinternal"
  `);
  assert.deepEqual(triggers.rows, []);

  const rules = await client.query<{
    relationName: string;
    ruleName: string;
  }>(`
    SELECT
      "pg_class"."relname" AS "relationName",
      "pg_rewrite"."rulename" AS "ruleName"
    FROM "pg_rewrite"
    INNER JOIN "pg_class" ON "pg_class"."oid" = "pg_rewrite"."ev_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
    ORDER BY "pg_class"."relname", "pg_rewrite"."rulename"
  `);
  assert.deepEqual(rules.rows, [
    { relationName: viewRelation, ruleName: "_RETURN" },
  ]);

  const viewDependencies = await client.query<{ relationName: string }>(
    `
      SELECT DISTINCT "referenced_relation"."relname" AS "relationName"
      FROM "pg_rewrite"
      INNER JOIN "pg_depend" ON "pg_depend"."objid" = "pg_rewrite"."oid"
      INNER JOIN "pg_class" AS "referenced_relation"
        ON "referenced_relation"."oid" = "pg_depend"."refobjid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "referenced_relation"."relnamespace"
      WHERE "pg_rewrite"."ev_class" = $1::regclass
        AND "pg_namespace"."nspname" = 'public'
        AND "referenced_relation"."relkind" = 'r'
      ORDER BY "referenced_relation"."relname"
    `,
    [`public.${viewRelation}`],
  );
  assert.deepEqual(viewDependencies.rows, [{ relationName: physicalRelation }]);

  return relations.rows;
}

async function readPhysicalRelationIdentity(
  client: Client,
  relationName: RelationName,
): Promise<PhysicalRelationIdentity> {
  const relations = await client.query<PhysicalRelationIdentity>(
    `
      SELECT
        "pg_relation_filenode"("pg_class"."oid")::text AS "relationFileNode",
        "pg_class"."relkind"::text AS "relationKind",
        "pg_class"."relname" AS "relationName",
        "pg_class"."oid"::text AS "relationOid"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = $1
    `,
    [relationName],
  );
  assert.equal(relations.rows.length, 1);
  const [identity] = relations.rows;
  assert.ok(identity);
  assert.equal(identity.relationKind, "r");
  assert.equal(identity.relationName, relationName);
  assert.ok(identity.relationFileNode.length > 0);
  assert.ok(identity.relationOid.length > 0);
  return identity;
}

async function readLegacyViewCatalogIdentity(
  client: Client,
): Promise<LegacyViewCatalogIdentity> {
  const identities = await client.query<LegacyViewCatalogIdentity>(`
    SELECT
      "pg_class"."oid"::text AS "relationOid",
      "pg_rewrite"."oid"::text AS "rewriteRuleOid"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    INNER JOIN "pg_rewrite"
      ON "pg_rewrite"."ev_class" = "pg_class"."oid"
      AND "pg_rewrite"."rulename" = '_RETURN'
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" = 'zero_agent_drafts'
      AND "pg_class"."relkind" = 'v'
  `);
  assert.equal(identities.rows.length, 1);
  const [identity] = identities.rows;
  assert.ok(identity);
  return identity;
}

async function validateCanonicalOnlyCatalog(
  client: Client,
  legacyIdentity: LegacyViewCatalogIdentity,
): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "pg_class"."relkind"::text AS "relationKind",
      "pg_class"."relname" AS "relationName"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN ('agent_drafts', 'zero_agent_drafts')
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(relations.rows, [
    { relationKind: "r", relationName: canonicalRelation },
  ]);

  const legacyViews = await client.query<{ tableName: string }>(`
    SELECT "table_name" AS "tableName"
    FROM "information_schema"."views"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'zero_agent_drafts'
  `);
  assert.deepEqual(legacyViews.rows, []);

  const legacyRules = await client.query<{ ruleOid: string }>(
    `
      SELECT "oid"::text AS "ruleOid"
      FROM "pg_rewrite"
      WHERE "ev_class" = $1::oid
        OR "oid" = $2::oid
    `,
    [legacyIdentity.relationOid, legacyIdentity.rewriteRuleOid],
  );
  assert.deepEqual(legacyRules.rows, []);

  const legacyTriggers = await client.query<{ triggerOid: string }>(
    `
      SELECT "oid"::text AS "triggerOid"
      FROM "pg_trigger"
      WHERE "tgrelid" = $1::oid
    `,
    [legacyIdentity.relationOid],
  );
  assert.deepEqual(legacyTriggers.rows, []);

  const legacyDependencies = await client.query<{ dependencyOid: string }>(
    `
      SELECT "objid"::text AS "dependencyOid"
      FROM "pg_depend"
      WHERE (
          "classid" = 'pg_class'::regclass
          AND "objid" = $1::oid
        )
        OR (
          "refclassid" = 'pg_class'::regclass
          AND "refobjid" = $1::oid
        )
        OR (
          "classid" = 'pg_rewrite'::regclass
          AND "objid" = $2::oid
        )
        OR (
          "refclassid" = 'pg_rewrite'::regclass
          AND "refobjid" = $2::oid
        )
    `,
    [legacyIdentity.relationOid, legacyIdentity.rewriteRuleOid],
  );
  assert.deepEqual(legacyDependencies.rows, []);

  const legacySharedDependencies = await client.query<{
    dependencyOid: string;
  }>(
    `
      SELECT "objid"::text AS "dependencyOid"
      FROM "pg_shdepend"
      WHERE (
          "classid" = 'pg_class'::regclass
          AND "objid" = $1::oid
        )
        OR (
          "refclassid" = 'pg_class'::regclass
          AND "refobjid" = $1::oid
        )
        OR (
          "classid" = 'pg_rewrite'::regclass
          AND "objid" = $2::oid
        )
        OR (
          "refclassid" = 'pg_rewrite'::regclass
          AND "refobjid" = $2::oid
        )
    `,
    [legacyIdentity.relationOid, legacyIdentity.rewriteRuleOid],
  );
  assert.deepEqual(legacySharedDependencies.rows, []);
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
      "pg_index"."indexrelid"::text AS "objectOid",
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
      AND "index_relation"."relname" IN (
        'idx_agent_drafts_user_org_agent',
        'idx_zero_agent_drafts_user_org_agent'
      )

    UNION ALL

    SELECT
      "pg_constraint"."contype"::text AS "constraintType",
      "pg_get_constraintdef"("pg_constraint"."oid", true) AS "definition",
      NULL::boolean AS "isUnique",
      "pg_constraint"."conname" AS "objectName",
      "pg_constraint"."oid"::text AS "objectOid",
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
        'agent_drafts_agent_id_agents_id_fk',
        'agent_drafts_draft_user_message_check',
        'zero_agent_drafts_agent_id_agents_id_fk',
        'zero_agent_drafts_draft_user_message_check'
      )

    ORDER BY "objectName"
  `);
  return objects.rows;
}

async function readAllPhysicalObjectDefinitions(
  client: Client,
  relationName: RelationName,
): Promise<PhysicalObjectDefinition[]> {
  const objects = await client.query<PhysicalObjectDefinition>(
    `
      SELECT
        NULL::text AS "constraintType",
        "pg_get_indexdef"("pg_index"."indexrelid") AS "definition",
        "pg_index"."indisunique" AS "isUnique",
        "index_relation"."relname" AS "objectName",
        "pg_index"."indexrelid"::text AS "objectOid",
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
        AND "table_relation"."relname" = $1

      UNION ALL

      SELECT
        "pg_constraint"."contype"::text AS "constraintType",
        "pg_get_constraintdef"("pg_constraint"."oid", true) AS "definition",
        NULL::boolean AS "isUnique",
        "pg_constraint"."conname" AS "objectName",
        "pg_constraint"."oid"::text AS "objectOid",
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
        AND "table_relation"."relname" = $1
        AND "pg_constraint"."contype" IN ('f', 'c')

      ORDER BY "objectName"
    `,
    [relationName],
  );
  return objects.rows;
}

function validatePhysicalObjectDefinitions(
  objects: PhysicalObjectDefinition[],
  physicalRelation: RelationName,
): void {
  const expectedNames = physicalObjectNames[physicalRelation];
  assert.deepEqual(
    objects
      .map(({ objectName }) => {
        return objectName;
      })
      .sort(),
    [
      expectedNames.uniqueIndex,
      expectedNames.foreignKey,
      expectedNames.contentCheck,
    ].sort(),
  );
  assert.ok(
    objects.every(({ relationName }) => {
      return relationName === physicalRelation;
    }),
  );
  assert.ok(
    objects.every(({ objectOid }) => {
      return objectOid.length > 0;
    }),
  );

  const uniqueIndex = objects.find(({ objectType }) => {
    return objectType === "index";
  });
  const foreignKey = objects.find(({ constraintType }) => {
    return constraintType === "f";
  });
  const contentCheck = objects.find(({ constraintType }) => {
    return constraintType === "c";
  });
  assert.ok(uniqueIndex);
  assert.ok(foreignKey);
  assert.ok(contentCheck);
  assert.deepEqual(
    {
      isUnique: uniqueIndex.isUnique,
      objectName: uniqueIndex.objectName,
      objectType: uniqueIndex.objectType,
    },
    {
      isUnique: true,
      objectName: expectedNames.uniqueIndex,
      objectType: "index",
    },
  );
  assert.equal(
    uniqueIndex.definition,
    `CREATE UNIQUE INDEX ${expectedNames.uniqueIndex} ON public.${physicalRelation} USING btree (user_id, org_id, agent_id)`,
  );
  assert.deepEqual(
    {
      constraintType: foreignKey.constraintType,
      objectName: foreignKey.objectName,
      referencedRelation: foreignKey.referencedRelation,
    },
    {
      constraintType: "f",
      objectName: expectedNames.foreignKey,
      referencedRelation: "agents",
    },
  );
  assert.equal(
    foreignKey.definition,
    "FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE",
  );
  assert.equal(contentCheck.constraintType, "c");
  assert.equal(contentCheck.objectName, expectedNames.contentCheck);
  assert.match(contentCheck.definition, /draft_user_message IS NOT NULL/u);
  assert.match(
    contentCheck.definition,
    /COALESCE\(draft_attachments, '\[\]'::jsonb\) = '\[\]'::jsonb/u,
  );
}

function physicalObjectIdentity(objects: PhysicalObjectDefinition[]): {
  readonly constraintType: string | null;
  readonly objectOid: string;
  readonly objectType: string;
}[] {
  return objects
    .map(({ constraintType, objectOid, objectType }) => {
      return { constraintType, objectOid, objectType };
    })
    .sort((left, right) => {
      return left.objectOid.localeCompare(right.objectOid);
    });
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

async function selectAllDrafts(
  client: Client,
  relation: RelationName,
): Promise<DraftRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<DraftRow>(`
    SELECT
      "user_id" AS "userId",
      "org_id" AS "orgId",
      "agent_id"::text AS "agentId",
      "draft_user_message"::text AS "draftUserMessage",
      "draft_attachments"::text AS "draftAttachments",
      "created_at"::text AS "createdAt",
      "updated_at"::text AS "updatedAt"
    FROM ${relationIdentifier}
    ORDER BY "user_id", "org_id", "agent_id"
  `);
  return result.rows;
}

async function readCompatibleRows(client: Client): Promise<DraftRow[]> {
  const canonicalRows = await selectAllDrafts(client, canonicalRelation);
  const legacyRows = await selectAllDrafts(client, legacyRelation);
  assert.deepEqual(legacyRows, canonicalRows);
  return canonicalRows;
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
  scenario: string,
): Promise<void> {
  const userId = `${scenario}-${relation}-statement-user`;
  const orgId = `${scenario}-${relation}-statement-org`;
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

async function validateSealedPersistence(
  client: Client,
  relation: RelationName,
  counterpart: RelationName,
  scenario: string,
): Promise<void> {
  const initialWrite: DraftWriteFixture = {
    agentId: parentAgentId,
    draftAttachments: null,
    draftUserMessage: `{"version":1,"parts":[{"type":"text","text":"${scenario} ${relation} first"}]}`,
    orgId: `${scenario}-${relation}-sealed-org`,
    updatedAt: "2026-08-26 04:00:00",
    userId: `${scenario}-${relation}-sealed-user`,
  };
  assert.equal(
    await persistDraftWithSealedShape(client, relation, initialWrite),
    0,
  );

  const initialRows = await selectDraft(
    client,
    counterpart,
    initialWrite.userId,
    initialWrite.orgId,
    initialWrite.agentId,
  );
  assert.equal(initialRows.length, 1);
  const [initialRow] = initialRows;
  assert.ok(initialRow);
  assert.ok(initialRow.createdAt.length > 0);
  assert.equal(initialRow.updatedAt, initialWrite.updatedAt);

  const updatedWrite: DraftWriteFixture = {
    ...initialWrite,
    draftUserMessage: `{"version":1,"parts":[{"type":"text","text":"${scenario} ${relation} updated"}]}`,
    updatedAt: "2026-08-26 04:05:00",
  };
  assert.equal(
    await persistDraftWithSealedShape(client, relation, updatedWrite),
    0,
  );

  const updatedRows = await selectDraft(
    client,
    counterpart,
    updatedWrite.userId,
    updatedWrite.orgId,
    updatedWrite.agentId,
  );
  assert.equal(updatedRows.length, 1);
  const [updatedRow] = updatedRows;
  assert.ok(updatedRow);
  assert.equal(updatedRow.createdAt, initialRow.createdAt);
  assert.equal(updatedRow.updatedAt, updatedWrite.updatedAt);
  assert.notEqual(updatedRow.draftUserMessage, initialRow.draftUserMessage);
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

async function validateConstraintPropagation(
  client: Client,
  relation: RelationName,
  counterpart: RelationName,
  scenario: string,
): Promise<void> {
  const relationIdentifier = relationIdentifiers[relation];
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO ${relationIdentifier} (
          "user_id",
          "org_id",
          "agent_id",
          "draft_user_message"
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        `${scenario}-${relation}-missing-agent-user`,
        `${scenario}-${relation}-missing-agent-org`,
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
    orgId: `${scenario}-${relation}-invalid-check-org`,
    updatedAt: "2026-08-26 03:30:00",
    userId: `${scenario}-${relation}-invalid-check-user`,
  };
  await expectDatabaseFailure(
    persistDraftWithSealedShape(client, relation, invalidWrite),
    "23514",
  );
  assert.deepEqual(
    await selectDraft(
      client,
      counterpart,
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
  relation: RelationName,
  counterpart: RelationName,
  scenario: string,
): Promise<void> {
  const participants = 8;
  const userId = `${scenario}-${relation}-concurrent-user`;
  const orgId = `${scenario}-${relation}-concurrent-org`;
  const relationIdentifier = relationIdentifiers[relation];
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
      orgId,
      updatedAt: `2026-08-26 03:00:0${index}`,
      userId,
    } satisfies DraftWriteFixture;
  });

  try {
    const retryCounts = await Promise.all(
      writers.map(async (writer, index) => {
        const write = writes[index];
        assert.ok(write);
        return persistDraftWithSealedShape(
          writer,
          relation,
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
    relation,
    userId,
    orgId,
    parentAgentId,
  );
  const legacyRows = await selectDraft(
    client,
    counterpart,
    userId,
    orgId,
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
      FROM ${relationIdentifier}
      WHERE "user_id" = $1
        AND "org_id" = $2
        AND "agent_id" = $3
    `,
    [userId, orgId, parentAgentId],
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

async function validateBothApiMappings(
  client: Client,
  databaseUrl: string,
  scenario: string,
): Promise<void> {
  for (const relation of [legacyRelation, canonicalRelation] as const) {
    const counterpart =
      relation === legacyRelation ? canonicalRelation : legacyRelation;
    await validateStatementShapes(
      client,
      databaseUrl,
      relation,
      counterpart,
      scenario,
    );
    await validateSealedPersistence(client, relation, counterpart, scenario);
    await validateConstraintPropagation(
      client,
      relation,
      counterpart,
      scenario,
    );
    await validateConcurrentFirstWrites(
      client,
      databaseUrl,
      relation,
      counterpart,
      scenario,
    );
  }
}

async function validateCanonicalStatementShapes(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  const userId = "after-contract-canonical-statement-user";
  const orgId = "after-contract-canonical-statement-org";
  const initialMessage =
    '{"version":1,"parts":[{"type":"text","text":"canonical initial"}]}';
  const insertedRows = await insertDraftWithDefaults(
    client,
    canonicalRelation,
    userId,
    orgId,
    parentAgentId,
    initialMessage,
  );
  assert.equal(insertedRows.length, 1);
  const [insertedRow] = insertedRows;
  assert.ok(insertedRow);
  assert.ok(insertedRow.createdAt.length > 0);
  assert.equal(insertedRow.updatedAt, insertedRow.createdAt);
  assert.deepEqual(
    await selectDraft(client, canonicalRelation, userId, orgId, parentAgentId),
    insertedRows,
  );

  const updatedMessage =
    '{"version":1,"parts":[{"type":"text","text":"canonical updated"}]}';
  const updatedRows = await updateDraft(
    client,
    canonicalRelation,
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
    await selectDraft(client, canonicalRelation, userId, orgId, parentAgentId),
    updatedRows,
  );

  await validateCrossRelationLock(
    client,
    databaseUrl,
    canonicalRelation,
    canonicalRelation,
    userId,
    orgId,
    parentAgentId,
  );

  const deletedRows = await deleteDraft(
    client,
    canonicalRelation,
    userId,
    orgId,
    parentAgentId,
  );
  assert.deepEqual(deletedRows, updatedRows);
  assert.deepEqual(
    await selectDraft(client, canonicalRelation, userId, orgId, parentAgentId),
    [],
  );
}

async function validateCanonicalOnlyBehavior(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  await validateCanonicalStatementShapes(client, databaseUrl);
  await validateSealedPersistence(
    client,
    canonicalRelation,
    canonicalRelation,
    "after-contract",
  );
  await validateConstraintPropagation(
    client,
    canonicalRelation,
    canonicalRelation,
    "after-contract",
  );
  await validateConcurrentFirstWrites(
    client,
    databaseUrl,
    canonicalRelation,
    canonicalRelation,
    "after-contract",
  );
}

export async function validateAgentDraftsCompatibilityRelation(): Promise<void> {
  console.log("=== Validate Agent Draft physical relation switch ===\n");

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
    const physicalObjectsBeforeExpansion =
      await readPhysicalObjectDefinitions(client);
    validatePhysicalObjectDefinitions(
      physicalObjectsBeforeExpansion,
      legacyRelation,
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    const relationsBeforeSwitch = await validateCompatibilityCatalog(
      client,
      legacyRelation,
      canonicalRelation,
    );
    await validateHistoricalRow(client);

    const physicalObjectsBeforeSwitch =
      await readPhysicalObjectDefinitions(client);
    validatePhysicalObjectDefinitions(
      physicalObjectsBeforeSwitch,
      legacyRelation,
    );
    assert.deepEqual(
      physicalObjectsBeforeSwitch,
      physicalObjectsBeforeExpansion,
    );

    await validateBothApiMappings(client, testUrl.toString(), "before-switch");
    const rowsBeforeSwitch = await readCompatibleRows(client);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      switchMigration,
    );
    const relationsAfterSwitch = await validateCompatibilityCatalog(
      client,
      canonicalRelation,
      legacyRelation,
    );

    const physicalRelationBeforeSwitch = relationsBeforeSwitch.find(
      ({ relationName }) => {
        return relationName === legacyRelation;
      },
    );
    const physicalRelationAfterSwitch = relationsAfterSwitch.find(
      ({ relationName }) => {
        return relationName === canonicalRelation;
      },
    );
    assert.ok(physicalRelationBeforeSwitch);
    assert.ok(physicalRelationAfterSwitch);
    assert.equal(
      physicalRelationAfterSwitch.relationOid,
      physicalRelationBeforeSwitch.relationOid,
    );

    const physicalObjectsAfterSwitch =
      await readPhysicalObjectDefinitions(client);
    validatePhysicalObjectDefinitions(
      physicalObjectsAfterSwitch,
      canonicalRelation,
    );
    assert.deepEqual(
      physicalObjectIdentity(physicalObjectsAfterSwitch),
      physicalObjectIdentity(physicalObjectsBeforeSwitch),
    );

    const rowsAfterSwitch = await readCompatibleRows(client);
    assert.deepEqual(rowsAfterSwitch, rowsBeforeSwitch);

    await validateBothApiMappings(client, testUrl.toString(), "after-switch");

    const canonicalIdentityBeforeContract = await readPhysicalRelationIdentity(
      client,
      canonicalRelation,
    );
    const legacyIdentityBeforeContract =
      await readLegacyViewCatalogIdentity(client);
    const physicalObjectsBeforeContract =
      await readAllPhysicalObjectDefinitions(client, canonicalRelation);
    assert.deepEqual(physicalObjectsBeforeContract, physicalObjectsAfterSwitch);
    const rowsBeforeContract = await selectAllDrafts(client, canonicalRelation);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractMigration,
    );
    await validateCanonicalOnlyCatalog(client, legacyIdentityBeforeContract);

    const canonicalIdentityAfterContract = await readPhysicalRelationIdentity(
      client,
      canonicalRelation,
    );
    assert.deepEqual(
      canonicalIdentityAfterContract,
      canonicalIdentityBeforeContract,
    );

    const physicalObjectsAfterContract = await readAllPhysicalObjectDefinitions(
      client,
      canonicalRelation,
    );
    validatePhysicalObjectDefinitions(
      physicalObjectsAfterContract,
      canonicalRelation,
    );
    assert.deepEqual(
      physicalObjectsAfterContract,
      physicalObjectsBeforeContract,
    );

    const rowsAfterContract = await selectAllDrafts(client, canonicalRelation);
    assert.deepEqual(rowsAfterContract, rowsBeforeContract);

    await validateCanonicalOnlyBehavior(client, testUrl.toString());

    console.log(
      "   ✅ the canonical table preserves the legacy table OID and every row",
    );
    console.log(
      "   ✅ the legacy view exposes exactly seven columns through a native writable rule",
    );
    console.log(
      "   ✅ the canonical index, foreign key, and check retain their physical OIDs and semantics",
    );
    console.log(
      "   ✅ old and new API mappings share reads, DML, defaults, returning, locking, and constraints before and after the switch",
    );
    console.log(
      "   ✅ both mappings preserve the sealed update-first/plain-insert/exact-23505 retry behavior\n",
    );
    console.log(
      "   ✅ the contract removes every legacy relation, rule, trigger, and dependency",
    );
    console.log(
      "   ✅ the canonical table, filenode, rows, index, foreign key, and check survive unchanged",
    );
    console.log(
      "   ✅ canonical-only SELECT, DML, defaults, returning, locking, constraints, and exact-23505 recovery pass\n",
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
