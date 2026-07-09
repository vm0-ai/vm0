/**
 * In-process test fixtures for relationship-memory recall state whose product
 * setup requires asynchronous provider extraction and search indexing.
 */
import {
  memories,
  memoryEdges,
  memoryEntities,
  memorySearchEntries,
  type MemoryKind,
} from "@vm0/db/schema/memory-substrate";
import { createStore } from "ccstate";

import { writeDb$, type Db } from "../signals/external/db";
import {
  createDeterministicMemoryEmbeddingForTest,
  memoryEmbeddingContentHash,
} from "../signals/services/zero-memory-embedding.service";

interface RelationshipMemoryFixture {
  readonly orgId: string;
  readonly userId: string;
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
  readonly fixture: RelationshipMemoryFixture;
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
    orgId: args.fixture.orgId,
    userId: args.fixture.userId,
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

export async function seedSemanticRecallMemory(
  fixture: RelationshipMemoryFixture,
  query: string,
): Promise<void> {
  const db = createStore().set(writeDb$);
  const displayName = "Portfolio Settings";
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "organization",
      displayName,
    })
    .returning({ id: memoryEntities.id });
  if (!entity) {
    throw new Error("Expected semantic recall fixture entity");
  }

  const lastSeenAt = new Date("2026-07-05T12:00:00.000Z");
  const text = "The user prefers JPM IJTXX Treasury allocation.";
  const [memory] = await db
    .insert(memories)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      entityId: entity.id,
      kind: "preference",
      status: "active" as const,
      text,
      confidence: 95,
      lastSeenAt,
    })
    .returning({ id: memories.id });
  if (!memory) {
    throw new Error("Expected semantic recall fixture memory");
  }

  await insertSearchEntryForMemory({
    db,
    fixture,
    entityId: entity.id,
    memoryId: memory.id,
    kind: "preference",
    memoryText: text,
    displayName,
    query,
    confidence: 95,
    lastSeenAt,
  });
}

export async function seedGraphExpansionMemories(
  fixture: RelationshipMemoryFixture,
  query: string,
): Promise<void> {
  const db = createStore().set(writeDb$);
  const displayName = "Lucent Migration";
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "organization",
      displayName,
    })
    .returning({ id: memoryEntities.id });
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
        orgId: fixture.orgId,
        userId: fixture.userId,
        entityId: entity.id,
        kind: "key_fact" as const,
        status: "active" as const,
        text: seedText,
        confidence: 91,
        lastSeenAt: seedLastSeenAt,
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        entityId: entity.id,
        kind: "open_loop" as const,
        status: "active" as const,
        text: relatedText,
        confidence: 89,
        lastSeenAt: relatedLastSeenAt,
      },
    ])
    .returning({ id: memories.id, text: memories.text, kind: memories.kind });
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
    orgId: fixture.orgId,
    userId: fixture.userId,
    fromMemoryId: seed.id,
    toMemoryId: related.id,
    edgeType: "extends",
  });
  await insertSearchEntryForMemory({
    db,
    fixture,
    entityId: entity.id,
    memoryId: seed.id,
    kind: seed.kind,
    memoryText: seedText,
    displayName,
    query,
    confidence: 91,
    lastSeenAt: seedLastSeenAt,
  });
}
