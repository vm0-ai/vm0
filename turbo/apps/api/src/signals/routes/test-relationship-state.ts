import { command } from "ccstate";
import {
  testRelationshipStateContract,
  type TestRelationshipStateActionBody,
  type TestRelationshipStateFixture,
} from "@vm0/api-contracts/contracts/test-relationship-state";
import {
  type MemoryKind,
  memories,
  memoryEdges,
  memoryEntities,
  memoryEntityAliases,
  memoryProfiles,
  memorySearchEntries,
  memorySources,
} from "@vm0/db/schema/memory-substrate";
import { and, eq, sql } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";
import {
  createDeterministicMemoryEmbeddingForTest,
  memoryEmbeddingContentHash,
} from "../services/zero-memory-embedding.service";

const actionBody$ = bodyResultOf(testRelationshipStateContract.action);
const FIXTURE_START_TIME = Date.parse("2026-07-05T12:00:00.000Z");

type RelationshipAction<
  TAction extends TestRelationshipStateActionBody["action"],
> = Extract<TestRelationshipStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

function scopedWhere(body: RelationshipAction<"delete-relationships">) {
  return {
    orgId: body.fixture.org_id,
    userId: body.fixture.user_id,
  };
}

async function deleteRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"delete-relationships">,
  signal: AbortSignal,
) {
  const scope = scopedWhere(body);
  await db
    .delete(memories)
    .where(
      and(eq(memories.orgId, scope.orgId), eq(memories.userId, scope.userId)),
    );
  await db
    .delete(memorySources)
    .where(
      and(
        eq(memorySources.orgId, scope.orgId),
        eq(memorySources.userId, scope.userId),
      ),
    );
  await db
    .delete(memoryEntities)
    .where(
      and(
        eq(memoryEntities.orgId, scope.orgId),
        eq(memoryEntities.userId, scope.userId),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

function relationshipEntityValues(
  body: RelationshipAction<"seed-relationships">,
) {
  return Array.from({ length: body.count }, (_, index) => {
    const entityType: "person" | "organization" =
      index % 2 === 0 ? "person" : "organization";
    return {
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      type: entityType,
      identityKey: `${entityType}-${index}@relationship.test`,
      displayName: `Relationship ${String(index + 1).padStart(3, "0")}`,
      primaryEmail:
        entityType === "person" ? `person-${index}@relationship.test` : null,
      domain: `relationship-${index}.test`,
    };
  });
}

async function insertRelationshipEntityFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
) {
  const values = relationshipEntityValues(body);
  const entities = await db
    .insert(memoryEntities)
    .values(
      values.map((entity) => {
        return {
          orgId: entity.orgId,
          userId: entity.userId,
          type: entity.type,
          displayName: entity.displayName,
        };
      }),
    )
    .returning({
      id: memoryEntities.id,
      type: memoryEntities.type,
      displayName: memoryEntities.displayName,
    });
  return entities.map((entity, index) => {
    const value = values[index];
    if (!value) {
      throw new Error("Expected relationship fixture entity value");
    }
    return {
      ...entity,
      identityKey: value.identityKey,
      primaryEmail: value.primaryEmail,
      domain: value.domain,
    };
  });
}

type RelationshipEntityFixture = Awaited<
  ReturnType<typeof insertRelationshipEntityFixtures>
>[number];

async function insertGraphEntityAliases(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  await db.insert(memoryEntityAliases).values(
    entities.flatMap((entity) => {
      return [
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          provider: null,
          aliasType: "relationship_identity" as const,
          aliasValue: entity.identityKey,
        },
        ...(entity.primaryEmail
          ? [
              {
                orgId: body.fixture.org_id,
                userId: body.fixture.user_id,
                entityId: entity.id,
                provider: null,
                aliasType: "email" as const,
                aliasValue: entity.primaryEmail,
              },
            ]
          : []),
        ...(entity.type === "organization" && entity.domain
          ? [
              {
                orgId: body.fixture.org_id,
                userId: body.fixture.user_id,
                entityId: entity.id,
                provider: null,
                aliasType: "domain" as const,
                aliasValue: entity.domain,
              },
            ]
          : []),
      ];
    }),
  );
}

async function insertRelationshipProfileFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  await db.insert(memoryProfiles).values(
    entities.flatMap((entity, index) => {
      const lastInteractionAt = new Date(
        FIXTURE_START_TIME - index * 60_000,
      ).toISOString();
      return [
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_type",
          content: index % 2 === 0 ? "Customer contact" : "Organization",
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_status",
          content: "active",
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_summary",
          content: `Relationship pagination fixture ${index + 1}`,
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_last_interaction_at",
          content: lastInteractionAt,
        },
      ];
    }),
  );
}

function openLoopFixtureItems(
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  return entities
    .map((entity, index) => {
      if (index % 10 !== 0) {
        return null;
      }
      return {
        orgId: body.fixture.org_id,
        userId: body.fixture.user_id,
        entityId: entity.id,
        kind: "open_loop" as const,
        text: `Follow up with relationship ${index + 1}`,
        confidence: 90,
        lastSeenAt: new Date(FIXTURE_START_TIME - index * 60_000),
      };
    })
    .filter((item): item is NonNullable<typeof item> => {
      return item !== null;
    });
}

async function insertOpenLoopFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  const openLoopItems = openLoopFixtureItems(body, entities);
  if (openLoopItems.length > 0) {
    await db.insert(memories).values(
      openLoopItems.map((item) => {
        return {
          orgId: item.orgId,
          userId: item.userId,
          entityId: item.entityId,
          kind: item.kind,
          status: "active" as const,
          text: item.text,
          confidence: item.confidence,
          sourceCount: 0,
          lastSeenAt: item.lastSeenAt,
        };
      }),
    );
  }
}

async function seedRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  signal: AbortSignal,
) {
  if (body.count === 0) {
    return actionOk();
  }

  const entities = await insertRelationshipEntityFixtures(db, body);
  signal.throwIfAborted();
  await insertGraphEntityAliases(db, body, entities);
  signal.throwIfAborted();
  await insertRelationshipProfileFixtures(db, body, entities);
  signal.throwIfAborted();
  await insertOpenLoopFixtures(db, body, entities);
  signal.throwIfAborted();
  return actionOk();
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createAliasRaceTriggerForAction(
  db: Db,
  body: RelationshipAction<"create-alias-race-trigger">,
  signal: AbortSignal,
) {
  const functionName = quoteSqlIdentifier(body.function_name);
  const triggerName = quoteSqlIdentifier(body.trigger_name);
  const displayName = quoteSqlString(body.display_name);
  const identityKey = quoteSqlString(body.identity_key);

  await db.execute(
    sql.raw(`
      CREATE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        canonical_id uuid;
      BEGIN
        IF NEW.display_name <> ${displayName} THEN
          RETURN NEW;
        END IF;

        INSERT INTO "memory_entities" (
          "org_id",
          "user_id",
          "type",
          "display_name",
          "created_at",
          "updated_at"
        )
        VALUES (
          NEW.org_id,
          NEW.user_id,
          NEW.type,
          'Alias Race Winner',
          now(),
          now()
        )
        RETURNING "id" INTO canonical_id;

        INSERT INTO "memory_entity_aliases" (
          "org_id",
          "user_id",
          "entity_id",
          "provider",
          "alias_type",
          "alias_value",
          "created_at",
          "updated_at"
        )
        VALUES (
          NEW.org_id,
          NEW.user_id,
          canonical_id,
          NULL,
          'relationship_identity',
          ${identityKey},
          now(),
          now()
        );

        RETURN NEW;
      END
      $$;
    `),
  );
  signal.throwIfAborted();
  await db.execute(
    sql.raw(`
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON "memory_entities"
      FOR EACH ROW
      EXECUTE FUNCTION ${functionName}();
    `),
  );
  signal.throwIfAborted();
  return actionOk();
}

async function deleteAliasRaceTriggerForAction(
  db: Db,
  body: RelationshipAction<"delete-alias-race-trigger">,
  signal: AbortSignal,
) {
  const functionName = quoteSqlIdentifier(body.function_name);
  const triggerName = quoteSqlIdentifier(body.trigger_name);

  await db.execute(
    sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON "memory_entities";`),
  );
  signal.throwIfAborted();
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}();`));
  signal.throwIfAborted();
  return actionOk();
}

interface RuntimeInjectionSeedRow {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly confidence: number;
  readonly lastSeenAt: string;
}

function searchEntryText(args: {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly displayName: string;
}): string {
  return [
    args.text.trim(),
    `Kind: ${args.kind}`,
    `Entity: ${args.displayName}`,
  ].join("\n");
}

async function insertSearchEntryForMemory(args: {
  readonly db: Db;
  readonly fixture: TestRelationshipStateFixture;
  readonly entityId: string;
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly memoryText: string;
  readonly displayName: string;
  readonly query: string;
  readonly confidence: number;
  readonly lastSeenAt: Date;
}) {
  const entryText = searchEntryText({
    text: args.memoryText,
    kind: args.kind,
    displayName: args.displayName,
  });
  const embeddingModel = "test-deterministic-embedding";
  await args.db.insert(memorySearchEntries).values({
    orgId: args.fixture.org_id,
    userId: args.fixture.user_id,
    memoryId: args.memoryId,
    entityId: args.entityId,
    entryKind: "memory_text",
    memoryKind: args.kind,
    status: "active",
    text: entryText,
    embedding: createDeterministicMemoryEmbeddingForTest(args.query),
    embeddingModel,
    contentHash: memoryEmbeddingContentHash({
      model: embeddingModel,
      text: entryText,
    }),
    confidence: args.confidence,
    lastSeenAt: args.lastSeenAt,
  });
}

async function insertSemanticRecallMemoryForAction(
  db: Db,
  body: RelationshipAction<"seed-semantic-recall-memory">,
  signal: AbortSignal,
) {
  const displayName = "Portfolio Settings";
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      type: "organization",
      displayName,
    })
    .returning({ id: memoryEntities.id });
  signal.throwIfAborted();
  if (!entity) {
    throw new Error("Expected semantic recall fixture entity");
  }

  const lastSeenAt = new Date("2026-07-05T12:00:00.000Z");
  const text = "The user prefers JPM IJTXX Treasury allocation.";
  const [memory] = await db
    .insert(memories)
    .values({
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      entityId: entity.id,
      kind: "preference",
      status: "active" as const,
      text,
      confidence: 95,
      lastSeenAt,
    })
    .returning({ id: memories.id });
  signal.throwIfAborted();
  if (!memory) {
    throw new Error("Expected semantic recall fixture memory");
  }

  await insertSearchEntryForMemory({
    db,
    fixture: body.fixture,
    entityId: entity.id,
    memoryId: memory.id,
    kind: "preference",
    memoryText: text,
    displayName,
    query: body.query,
    confidence: 95,
    lastSeenAt,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function insertGraphExpansionMemoriesForAction(
  db: Db,
  body: RelationshipAction<"seed-graph-expansion-memories">,
  signal: AbortSignal,
) {
  const displayName = "Lucent Migration";
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      type: "organization",
      displayName,
    })
    .returning({ id: memoryEntities.id });
  signal.throwIfAborted();
  if (!entity) {
    throw new Error("Expected graph expansion fixture entity");
  }

  const seedLastSeenAt = new Date("2026-07-07T12:00:00.000Z");
  const relatedLastSeenAt = new Date("2026-07-06T12:00:00.000Z");
  const seedText =
    "The infrastructure rewrite uses Lucent as its internal migration name.";
  const relatedText = "Ask Lancy for the Lucent migration rollout owner.";
  const inserted = await db
    .insert(memories)
    .values([
      {
        orgId: body.fixture.org_id,
        userId: body.fixture.user_id,
        entityId: entity.id,
        kind: "key_fact" as const,
        status: "active" as const,
        text: seedText,
        confidence: 91,
        lastSeenAt: seedLastSeenAt,
      },
      {
        orgId: body.fixture.org_id,
        userId: body.fixture.user_id,
        entityId: entity.id,
        kind: "open_loop" as const,
        status: "active" as const,
        text: relatedText,
        confidence: 89,
        lastSeenAt: relatedLastSeenAt,
      },
    ])
    .returning({ id: memories.id, text: memories.text, kind: memories.kind });
  signal.throwIfAborted();
  const seed = inserted.find((memory) => {
    return memory.text === seedText;
  });
  const related = inserted.find((memory) => {
    return memory.text === relatedText;
  });
  if (!seed || !related) {
    throw new Error("Expected graph expansion fixture memories");
  }

  await db.insert(memoryEdges).values({
    orgId: body.fixture.org_id,
    userId: body.fixture.user_id,
    fromMemoryId: seed.id,
    toMemoryId: related.id,
    edgeType: "extends",
  });
  await insertSearchEntryForMemory({
    db,
    fixture: body.fixture,
    entityId: entity.id,
    memoryId: seed.id,
    kind: seed.kind,
    memoryText: seedText,
    displayName,
    query: body.query,
    confidence: 91,
    lastSeenAt: seedLastSeenAt,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function insertRuntimeInjectionMemories(
  db: Db,
  fixture: TestRelationshipStateFixture,
  seedRows: readonly RuntimeInjectionSeedRow[],
  signal: AbortSignal,
) {
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: fixture.org_id,
      userId: fixture.user_id,
      type: "person",
      displayName: "Alice Runtime",
    })
    .returning({ id: memoryEntities.id });
  signal.throwIfAborted();
  if (!entity) {
    throw new Error("Expected runtime injection fixture entity");
  }

  await db.insert(memories).values(
    seedRows.map((row) => {
      return {
        orgId: fixture.org_id,
        userId: fixture.user_id,
        entityId: entity.id,
        kind: row.kind,
        status: "active" as const,
        text: row.text,
        confidence: row.confidence,
        lastSeenAt: new Date(row.lastSeenAt),
      };
    }),
  );
  signal.throwIfAborted();
  return actionOk();
}

async function seedRuntimeInjectionMemoriesForAction(
  db: Db,
  body: RelationshipAction<"seed-runtime-injection-memories">,
  signal: AbortSignal,
) {
  const seedRows: readonly RuntimeInjectionSeedRow[] = [
    {
      kind: "preference",
      text: "The user prefers concise launch summaries.",
      confidence: 92,
      lastSeenAt: "2026-07-05T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "The current work is validating runtime memory injection.",
      confidence: 84,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    {
      kind: "open_loop",
      text: "Follow up on the security review injection preview.",
      confidence: 88,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
  ];
  return await insertRuntimeInjectionMemories(
    db,
    body.fixture,
    seedRows,
    signal,
  );
}

async function seedRuntimeInjectionWindowMemoriesForAction(
  db: Db,
  body: RelationshipAction<"seed-runtime-injection-window-memories">,
  signal: AbortSignal,
) {
  // Mirrors supermemory's profile-vs-search split: the stable/recent profile is
  // a bounded window, while the "relevant memories" section is a full-corpus
  // search that surfaces prompt-relevant memories the bounded window left out.
  // The higher-ranked recent_context rows fill the dynamic window, so the
  // low-confidence, older query-relevant row is excluded from the profile and
  // can only reach the prompt via query recall (and is therefore not deduped
  // away against the profile).
  const seedRows: readonly RuntimeInjectionSeedRow[] = [
    // Stable profile.
    {
      kind: "preference",
      text: "The user prefers concise launch summaries.",
      confidence: 92,
      lastSeenAt: "2026-07-05T12:00:00.000Z",
    },
    // Current context (open loop + recent context inside the bounded window).
    {
      kind: "open_loop",
      text: "Follow up on the security review injection preview.",
      confidence: 88,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "The current work is validating runtime memory injection.",
      confidence: 84,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    // Higher-ranked recent context that fills the bounded window and pushes the
    // query-relevant row below out of the profile sections.
    {
      kind: "recent_context",
      text: "Reviewing the Q3 roadmap draft.",
      confidence: 90,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Preparing the weekly investor update.",
      confidence: 89,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Coordinating the design system migration.",
      confidence: 87,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    {
      kind: "recent_context",
      text: "Testing the new onboarding flow.",
      confidence: 86,
      lastSeenAt: "2026-07-06T12:00:00.000Z",
    },
    // Query-relevant memory that falls outside the bounded recent-context window
    // (lowest confidence, oldest) and is only surfaced by prompt recall.
    {
      kind: "recent_context",
      text: "Capture findings from the security review injection preview session.",
      confidence: 55,
      lastSeenAt: "2026-06-20T12:00:00.000Z",
    },
  ];
  return await insertRuntimeInjectionMemories(
    db,
    body.fixture,
    seedRows,
    signal,
  );
}

const mutateRelationshipState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "delete-relationships": {
        return await deleteRelationshipsForAction(db, body, signal);
      }
      case "seed-relationships": {
        return await seedRelationshipsForAction(db, body, signal);
      }
      case "seed-runtime-injection-memories": {
        return await seedRuntimeInjectionMemoriesForAction(db, body, signal);
      }
      case "seed-runtime-injection-window-memories": {
        return await seedRuntimeInjectionWindowMemoriesForAction(
          db,
          body,
          signal,
        );
      }
      case "seed-semantic-recall-memory": {
        return await insertSemanticRecallMemoryForAction(db, body, signal);
      }
      case "seed-graph-expansion-memories": {
        return await insertGraphExpansionMemoriesForAction(db, body, signal);
      }
      case "create-alias-race-trigger": {
        return await createAliasRaceTriggerForAction(db, body, signal);
      }
      case "delete-alias-race-trigger": {
        return await deleteAliasRaceTriggerForAction(db, body, signal);
      }
    }
  },
);

export const testRelationshipStateRoutes: readonly RouteEntry[] = [
  {
    route: testRelationshipStateContract.action,
    handler: mutateRelationshipState$,
  },
];
