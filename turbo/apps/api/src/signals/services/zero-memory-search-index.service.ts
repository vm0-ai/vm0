import {
  memories,
  memoryEntities,
  memorySearchEntries,
} from "@vm0/db/schema/memory-substrate";
import { and, eq, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  embedZeroMemoryText,
  memoryEmbeddingContentHash,
} from "./zero-memory-embedding.service";

const log = logger("zero-memory-search-index");

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

type MemorySearchDeleteDb = Pick<Db, "delete">;

function memorySearchText(row: {
  readonly text: string;
  readonly kind: string;
  readonly displayName: string | null;
}): string {
  const lines = [row.text.trim(), `Kind: ${row.kind}`];
  if (row.displayName) {
    lines.push(`Entity: ${row.displayName}`);
  }
  return lines.join("\n");
}

async function loadIndexableMemory(
  db: ReadonlyDb,
  args: MemoryScope & { readonly memoryId: string },
) {
  const [row] = await db
    .select({
      id: memories.id,
      orgId: memories.orgId,
      userId: memories.userId,
      contextSpaceId: memories.contextSpaceId,
      entityId: memories.entityId,
      kind: memories.kind,
      status: memories.status,
      text: memories.text,
      confidence: memories.confidence,
      lastSeenAt: memories.lastSeenAt,
      displayName: memoryEntities.displayName,
    })
    .from(memories)
    .leftJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .where(
      and(
        eq(memories.orgId, args.orgId),
        eq(memories.userId, args.userId),
        eq(memories.id, args.memoryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteZeroMemorySearchEntryForMemory(
  db: MemorySearchDeleteDb,
  args: MemoryScope & { readonly memoryId: string },
): Promise<void> {
  await db
    .delete(memorySearchEntries)
    .where(
      and(
        eq(memorySearchEntries.orgId, args.orgId),
        eq(memorySearchEntries.userId, args.userId),
        eq(memorySearchEntries.memoryId, args.memoryId),
      ),
    );
}

async function syncZeroMemorySearchEntryForMemory(
  db: Db,
  args: MemoryScope & { readonly memoryId: string },
): Promise<void> {
  const row = await loadIndexableMemory(db, args);
  if (!row || row.status !== "active") {
    await deleteZeroMemorySearchEntryForMemory(db, args);
    return;
  }

  const text = memorySearchText(row);
  const embedded = await embedZeroMemoryText(text);
  if (!embedded) {
    return;
  }

  const contentHash = memoryEmbeddingContentHash({
    model: embedded.model,
    text,
  });
  const currentTime = nowDate();

  await db
    .insert(memorySearchEntries)
    .values({
      orgId: row.orgId,
      userId: row.userId,
      contextSpaceId: row.contextSpaceId,
      memoryId: row.id,
      entityId: row.entityId,
      entryKind: "memory_text",
      memoryKind: row.kind,
      status: row.status,
      text,
      embedding: embedded.embedding,
      embeddingModel: embedded.model,
      contentHash,
      confidence: row.confidence,
      lastSeenAt: row.lastSeenAt,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        memorySearchEntries.memoryId,
        memorySearchEntries.entryKind,
        memorySearchEntries.embeddingModel,
      ],
      set: {
        entityId: row.entityId,
        contextSpaceId: row.contextSpaceId,
        memoryKind: row.kind,
        status: row.status,
        text,
        embedding: embedded.embedding,
        contentHash,
        confidence: row.confidence,
        lastSeenAt: row.lastSeenAt,
        updatedAt: currentTime,
      },
      setWhere: sql`${memorySearchEntries.contentHash} <> ${contentHash}
        or ${memorySearchEntries.status} <> ${row.status}
        or ${memorySearchEntries.confidence} <> ${row.confidence}
        or ${memorySearchEntries.lastSeenAt} <> ${row.lastSeenAt}`,
    });
}

export async function trySyncZeroMemorySearchEntryForMemory(
  db: Db,
  args: MemoryScope & { readonly memoryId: string },
): Promise<void> {
  const result = await settle(syncZeroMemorySearchEntryForMemory(db, args));
  if (result.ok) {
    return;
  }
  log.warn("Failed to sync zero memory search entry", {
    memoryId: args.memoryId,
    error: result.error,
  });
}
