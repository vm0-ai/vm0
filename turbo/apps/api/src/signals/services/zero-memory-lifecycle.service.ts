import type {
  MemoryCreateRequest,
  MemoryDocumentListResponse,
  MemoryForgetByPromptRequest,
  MemoryForgetResponse,
  MemoryHistoryResponse,
  MemoryKind,
  MemoryLifecycleMemory,
  MemoryListResponse,
  MemoryProfileListResponse,
  MemoryTombstoneListResponse,
  MemoryUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  memories,
  memoryContextSpaces,
  memoryDocumentChunks,
  memoryDocumentSearchEntries,
  memoryDocuments,
  memoryEntities,
  memoryProfiles,
  memoryTombstones,
  memoryVersions,
  type MemoryProvider,
  type MemoryTombstoneTargetKind,
  type MemoryVersionTargetKind,
} from "@vm0/db/schema/memory-substrate";
import { and, count, desc, eq, inArray } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import {
  defaultUserMemoryContextSpace,
  memoryContentHash,
  upsertMemoryContextSpace,
} from "./memory-substrate.service";
import {
  deleteZeroMemorySearchEntryForMemory,
  trySyncZeroMemorySearchEntryForMemory,
} from "./zero-memory-search-index.service";
import { searchZeroMemory } from "./zero-memory-search.service";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface PaginationParams {
  readonly page: number;
  readonly limit: number;
}

type MemoryRow = typeof memories.$inferSelect;
type MemoryDocumentRow = typeof memoryDocuments.$inferSelect;
type MemoryContextSpaceResponse = NonNullable<
  MemoryLifecycleMemory["contextSpace"]
>;
type MemoryTombstoneResponse = MemoryForgetResponse["forgotten"][number];

const DIRECT_MEMORY_ENTITY_DISPLAY_NAME = "Direct memories";

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function contextSpaceResponse(row: {
  readonly id: string | null;
  readonly type: MemoryContextSpaceResponse["type"] | null;
  readonly key: string | null;
  readonly displayName: string | null;
}): MemoryContextSpaceResponse | null {
  if (!row.id || !row.type || !row.key || !row.displayName) {
    return null;
  }
  return {
    id: row.id,
    type: row.type,
    key: row.key,
    displayName: row.displayName,
  };
}

function memoryDocumentIdentityFingerprint(args: {
  readonly provider: MemoryProvider;
  readonly externalId: string;
}): string {
  return `document:${args.provider}:${args.externalId}`;
}

function memoryDocumentContentFingerprint(contentHash: string): string {
  return `document-content:${contentHash}`;
}

function memoryTextFingerprint(text: string): string {
  return `memory-text:${memoryContentHash(text.trim().toLowerCase())}`;
}

async function ensureDirectMemoryEntity(
  db: Db,
  args: MemoryScope & { readonly displayName?: string },
): Promise<typeof memoryEntities.$inferSelect> {
  const displayName = args.displayName ?? DIRECT_MEMORY_ENTITY_DISPLAY_NAME;
  const [existing] = await db
    .select()
    .from(memoryEntities)
    .where(
      and(
        eq(memoryEntities.orgId, args.orgId),
        eq(memoryEntities.userId, args.userId),
        eq(memoryEntities.type, "organization"),
        eq(memoryEntities.displayName, displayName),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(memoryEntities)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: "organization",
      displayName,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    })
    .returning();
  if (!created) {
    throw new Error("Failed to create direct memory entity");
  }
  return created;
}

async function nextVersion(
  db: ReadonlyDb,
  args: {
    readonly targetKind: MemoryVersionTargetKind;
    readonly targetId: string;
  },
): Promise<number> {
  const [row] = await db
    .select({ version: memoryVersions.version })
    .from(memoryVersions)
    .where(
      and(
        eq(memoryVersions.targetKind, args.targetKind),
        eq(memoryVersions.targetId, args.targetId),
      ),
    )
    .orderBy(desc(memoryVersions.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}

async function recordMemoryVersion(
  db: Db,
  args: MemoryScope & {
    readonly contextSpaceId: string | null;
    readonly targetKind: MemoryVersionTargetKind;
    readonly targetId: string;
    readonly contentHash: string;
    readonly operation: "create" | "update" | "forget";
    readonly reason?: string;
    readonly text?: string;
    readonly title?: string | null;
    readonly kind?: string;
    readonly confidence?: number;
    readonly status?: string;
  },
): Promise<void> {
  await db.insert(memoryVersions).values({
    orgId: args.orgId,
    userId: args.userId,
    contextSpaceId: args.contextSpaceId,
    targetKind: args.targetKind,
    targetId: args.targetId,
    version: await nextVersion(db, args),
    contentHash: args.contentHash,
    metadata: {
      operation: args.operation,
      reason: args.reason,
      text: args.text,
      title: args.title,
      kind: args.kind,
      confidence: args.confidence,
      status: args.status,
    },
    createdAt: nowDate(),
  });
}

async function loadMemory(
  db: ReadonlyDb,
  args: MemoryScope & { readonly memoryId: string },
): Promise<MemoryLifecycleMemory | null> {
  const [row] = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      status: memories.status,
      text: memories.text,
      confidence: memories.confidence,
      sourceCount: memories.sourceCount,
      lastSeenAt: memories.lastSeenAt,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
      entityId: memoryEntities.id,
      entityType: memoryEntities.type,
      entityDisplayName: memoryEntities.displayName,
    })
    .from(memories)
    .leftJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memories.contextSpaceId),
    )
    .leftJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .where(
      and(
        eq(memories.orgId, args.orgId),
        eq(memories.userId, args.userId),
        eq(memories.id, args.memoryId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    text: row.text,
    confidence: row.confidence,
    sourceCount: row.sourceCount,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    contextSpace: contextSpaceResponse({
      id: row.contextSpaceId,
      type: row.contextSpaceType,
      key: row.contextSpaceKey,
      displayName: row.contextSpaceDisplayName,
    }),
    entity: {
      id: row.entityId,
      type: row.entityType,
      displayName: row.entityDisplayName,
    },
  };
}

async function loadMemoryRow(
  db: ReadonlyDb,
  args: MemoryScope & { readonly memoryId: string },
): Promise<MemoryRow | null> {
  const [row] = await db
    .select()
    .from(memories)
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

async function loadDocumentRow(
  db: ReadonlyDb,
  args: MemoryScope & { readonly documentId: string },
): Promise<MemoryDocumentRow | null> {
  const [row] = await db
    .select()
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.orgId, args.orgId),
        eq(memoryDocuments.userId, args.userId),
        eq(memoryDocuments.id, args.documentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertTombstone(
  db: Db,
  args: MemoryScope & {
    readonly contextSpaceId: string | null;
    readonly targetKind: MemoryTombstoneTargetKind;
    readonly fingerprint: string;
    readonly reason?: string;
    readonly prompt?: string;
    readonly targetId?: string;
    readonly targetTitle?: string | null;
    readonly targetText?: string | null;
  },
): Promise<void> {
  await db
    .insert(memoryTombstones)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      contextSpaceId: args.contextSpaceId,
      targetKind: args.targetKind,
      fingerprint: args.fingerprint,
      metadata: {
        reason: args.reason,
        prompt: args.prompt,
        targetId: args.targetId,
        targetTitle: args.targetTitle,
        targetText: args.targetText,
        source: args.prompt ? "prompt" : "direct",
      },
      createdAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: [
        memoryTombstones.orgId,
        memoryTombstones.userId,
        memoryTombstones.targetKind,
        memoryTombstones.fingerprint,
      ],
      set: {
        contextSpaceId: args.contextSpaceId,
        metadata: {
          reason: args.reason,
          prompt: args.prompt,
          targetId: args.targetId,
          targetTitle: args.targetTitle,
          targetText: args.targetText,
          source: args.prompt ? "prompt" : "direct",
        },
      },
    });
}

export async function memoryDocumentHasTombstone(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly provider: MemoryProvider;
    readonly externalId: string;
    readonly contentHash: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryTombstones.id })
    .from(memoryTombstones)
    .where(
      and(
        eq(memoryTombstones.orgId, args.orgId),
        eq(memoryTombstones.userId, args.userId),
        eq(memoryTombstones.targetKind, "document"),
        inArray(memoryTombstones.fingerprint, [
          memoryDocumentIdentityFingerprint(args),
          memoryDocumentContentFingerprint(args.contentHash),
        ]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function listInsertedTombstones(
  db: ReadonlyDb,
  args: MemoryScope & { readonly fingerprints: readonly string[] },
): Promise<readonly MemoryTombstoneResponse[]> {
  if (args.fingerprints.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: memoryTombstones.id,
      targetKind: memoryTombstones.targetKind,
      fingerprint: memoryTombstones.fingerprint,
      metadata: memoryTombstones.metadata,
      createdAt: memoryTombstones.createdAt,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
    })
    .from(memoryTombstones)
    .leftJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryTombstones.contextSpaceId),
    )
    .where(
      and(
        eq(memoryTombstones.orgId, args.orgId),
        eq(memoryTombstones.userId, args.userId),
        inArray(memoryTombstones.fingerprint, [...args.fingerprints]),
      ),
    )
    .orderBy(desc(memoryTombstones.createdAt));
  return rows.map((row) => {
    return {
      id: row.id,
      targetKind: row.targetKind,
      fingerprint: row.fingerprint,
      reason: row.metadata.reason ?? null,
      prompt: row.metadata.prompt ?? null,
      targetId: row.metadata.targetId ?? null,
      targetTitle: row.metadata.targetTitle ?? null,
      targetText: row.metadata.targetText ?? null,
      contextSpace: contextSpaceResponse({
        id: row.contextSpaceId,
        type: row.contextSpaceType,
        key: row.contextSpaceKey,
        displayName: row.contextSpaceDisplayName,
      }),
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function createMemory(
  db: Db,
  args: MemoryScope & MemoryCreateRequest,
): Promise<MemoryLifecycleMemory> {
  const contextSpace = await upsertMemoryContextSpace(db, {
    ...args,
    ...(args.contextSpace ?? defaultUserMemoryContextSpace(args)),
  });
  const entity = await ensureDirectMemoryEntity(db, {
    ...args,
    displayName: args.entityDisplayName,
  });
  const currentTime = nowDate();
  const [row] = await db
    .insert(memories)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      contextSpaceId: contextSpace.id,
      entityId: entity.id,
      kind: args.kind,
      status: "active",
      text: args.text,
      confidence: args.confidence,
      sourceCount: 0,
      lastSeenAt: currentTime,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .returning({ id: memories.id });
  if (!row) {
    throw new Error("Failed to create memory");
  }
  await recordMemoryVersion(db, {
    orgId: args.orgId,
    userId: args.userId,
    contextSpaceId: contextSpace.id,
    targetKind: "memory",
    targetId: row.id,
    contentHash: memoryContentHash(args.text),
    operation: "create",
    reason: "Direct memory creation",
    text: args.text,
    kind: args.kind,
    confidence: args.confidence,
    status: "active",
  });
  await trySyncZeroMemorySearchEntryForMemory(db, {
    orgId: args.orgId,
    userId: args.userId,
    memoryId: row.id,
  });
  const memory = await loadMemory(db, { ...args, memoryId: row.id });
  if (!memory) {
    throw new Error("Created memory could not be loaded");
  }
  return memory;
}

export async function updateMemory(
  db: Db,
  args: MemoryScope & { readonly memoryId: string } & MemoryUpdateRequest,
): Promise<MemoryLifecycleMemory | null> {
  const current = await loadMemoryRow(db, args);
  if (!current || current.status !== "active") {
    return null;
  }
  const contextSpace = args.contextSpace
    ? await upsertMemoryContextSpace(db, { ...args, ...args.contextSpace })
    : null;
  const entity = args.entityDisplayName
    ? await ensureDirectMemoryEntity(db, {
        ...args,
        displayName: args.entityDisplayName,
      })
    : null;
  const text = args.text ?? current.text;
  const kind = args.kind ?? current.kind;
  const confidence = args.confidence ?? current.confidence;
  const currentTime = nowDate();
  await db
    .update(memories)
    .set({
      ...(contextSpace ? { contextSpaceId: contextSpace.id } : {}),
      ...(entity ? { entityId: entity.id } : {}),
      text,
      kind,
      confidence,
      lastSeenAt: currentTime,
      updatedAt: currentTime,
    })
    .where(eq(memories.id, current.id));
  await recordMemoryVersion(db, {
    orgId: args.orgId,
    userId: args.userId,
    contextSpaceId: contextSpace?.id ?? current.contextSpaceId,
    targetKind: "memory",
    targetId: current.id,
    contentHash: memoryContentHash(text),
    operation: "update",
    reason: "Direct memory update",
    text,
    kind,
    confidence,
    status: "active",
  });
  await trySyncZeroMemorySearchEntryForMemory(db, {
    orgId: args.orgId,
    userId: args.userId,
    memoryId: current.id,
  });
  return await loadMemory(db, args);
}

export async function forgetMemory(
  db: Db,
  args: MemoryScope & {
    readonly memoryId: string;
    readonly reason?: string;
    readonly prompt?: string;
  },
): Promise<readonly MemoryTombstoneResponse[] | null> {
  const memory = await loadMemoryRow(db, args);
  if (!memory) {
    return null;
  }
  await db
    .update(memories)
    .set({ status: "archived", updatedAt: nowDate() })
    .where(eq(memories.id, memory.id));
  await deleteZeroMemorySearchEntryForMemory(db, args);
  const fingerprints = [
    `memory:${memory.id}`,
    memoryTextFingerprint(memory.text),
  ];
  for (const fingerprint of fingerprints) {
    await insertTombstone(db, {
      ...args,
      contextSpaceId: memory.contextSpaceId,
      targetKind: "memory",
      fingerprint,
      targetId: memory.id,
      targetText: memory.text,
    });
  }
  await recordMemoryVersion(db, {
    ...args,
    contextSpaceId: memory.contextSpaceId,
    targetKind: "memory",
    targetId: memory.id,
    contentHash: memoryContentHash(memory.text),
    operation: "forget",
    reason: args.reason ?? "Memory forgotten",
    text: memory.text,
    kind: memory.kind,
    confidence: memory.confidence,
    status: "archived",
  });
  return await listInsertedTombstones(db, { ...args, fingerprints });
}

export async function forgetDocument(
  db: Db,
  args: MemoryScope & {
    readonly documentId: string;
    readonly reason?: string;
    readonly prompt?: string;
  },
): Promise<readonly MemoryTombstoneResponse[] | null> {
  const document = await loadDocumentRow(db, args);
  if (!document) {
    return null;
  }
  await db
    .update(memoryDocuments)
    .set({ status: "deleted", updatedAt: nowDate() })
    .where(eq(memoryDocuments.id, document.id));
  await db
    .update(memoryDocumentChunks)
    .set({ status: "deleted", updatedAt: nowDate() })
    .where(eq(memoryDocumentChunks.documentId, document.id));
  await db
    .update(memoryDocumentSearchEntries)
    .set({ status: "deleted", updatedAt: nowDate() })
    .where(eq(memoryDocumentSearchEntries.documentId, document.id));
  const fingerprints = [
    memoryDocumentIdentityFingerprint(document),
    memoryDocumentContentFingerprint(document.contentHash),
  ];
  for (const fingerprint of fingerprints) {
    await insertTombstone(db, {
      ...args,
      contextSpaceId: document.contextSpaceId,
      targetKind: "document",
      fingerprint,
      targetId: document.id,
      targetTitle: document.title,
    });
  }
  await recordMemoryVersion(db, {
    ...args,
    contextSpaceId: document.contextSpaceId,
    targetKind: "document",
    targetId: document.id,
    contentHash: document.contentHash,
    operation: "forget",
    reason: args.reason ?? "Document forgotten",
    title: document.title,
    status: "deleted",
  });
  return await listInsertedTombstones(db, { ...args, fingerprints });
}

export async function forgetByPrompt(
  db: Db,
  args: MemoryScope & MemoryForgetByPromptRequest,
): Promise<MemoryForgetResponse> {
  const mode =
    args.targetKind === "memories"
      ? "memories"
      : args.targetKind === "documents"
        ? "documents"
        : "hybrid";
  const search = await searchZeroMemory(db, {
    orgId: args.orgId,
    userId: args.userId,
    q: args.prompt,
    mode,
    provider: args.provider,
    limit: args.limit,
  });
  const forgotten = new Map<string, MemoryTombstoneResponse>();
  const documentIds = new Set<string>();
  for (const result of search.results) {
    if (result.kind === "memory") {
      const tombstones = await forgetMemory(db, {
        ...args,
        memoryId: result.id,
      });
      for (const tombstone of tombstones ?? []) {
        forgotten.set(tombstone.id, tombstone);
      }
      continue;
    }
    if (!documentIds.has(result.documentId)) {
      documentIds.add(result.documentId);
      const tombstones = await forgetDocument(db, {
        ...args,
        documentId: result.documentId,
      });
      for (const tombstone of tombstones ?? []) {
        forgotten.set(tombstone.id, tombstone);
      }
    }
  }
  return { forgotten: [...forgotten.values()] };
}

export async function listMemories(
  db: ReadonlyDb,
  args: MemoryScope &
    PaginationParams & {
      readonly status: "active" | "archived";
      readonly kind?: MemoryKind;
    },
): Promise<MemoryListResponse> {
  const filters = [
    eq(memories.orgId, args.orgId),
    eq(memories.userId, args.userId),
    eq(memories.status, args.status),
  ];
  if (args.kind) {
    filters.push(eq(memories.kind, args.kind));
  }
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(memories)
    .where(and(...filters));
  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(...filters))
    .orderBy(desc(memories.updatedAt))
    .limit(args.limit)
    .offset((args.page - 1) * args.limit);
  const loaded = await Promise.all(
    rows.map((row) => {
      return loadMemory(db, { ...args, memoryId: row.id });
    }),
  );
  const pageCount = totalPages(total, args.limit);
  return {
    memories: loaded.filter((memory): memory is MemoryLifecycleMemory => {
      return memory !== null;
    }),
    pagination: {
      page: args.page,
      pageSize: args.limit,
      total,
      totalPages: pageCount,
      hasMore: args.page < pageCount,
    },
  };
}

export async function listMemoryDocuments(
  db: ReadonlyDb,
  args: MemoryScope &
    PaginationParams & {
      readonly status: "active" | "archived" | "deleted";
      readonly provider?: MemoryProvider;
    },
): Promise<MemoryDocumentListResponse> {
  const filters = [
    eq(memoryDocuments.orgId, args.orgId),
    eq(memoryDocuments.userId, args.userId),
    eq(memoryDocuments.status, args.status),
  ];
  if (args.provider) {
    filters.push(eq(memoryDocuments.provider, args.provider));
  }
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(memoryDocuments)
    .where(and(...filters));
  const rows = await db
    .select({
      id: memoryDocuments.id,
      status: memoryDocuments.status,
      title: memoryDocuments.title,
      provider: memoryDocuments.provider,
      sourceType: memoryDocuments.sourceType,
      externalId: memoryDocuments.externalId,
      contentHash: memoryDocuments.contentHash,
      occurredAt: memoryDocuments.occurredAt,
      createdAt: memoryDocuments.createdAt,
      updatedAt: memoryDocuments.updatedAt,
      metadata: memoryDocuments.metadata,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
      chunkCount: count(memoryDocumentChunks.id),
    })
    .from(memoryDocuments)
    .innerJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryDocuments.contextSpaceId),
    )
    .leftJoin(
      memoryDocumentChunks,
      eq(memoryDocumentChunks.documentId, memoryDocuments.id),
    )
    .where(and(...filters))
    .groupBy(
      memoryDocuments.id,
      memoryContextSpaces.id,
      memoryContextSpaces.type,
      memoryContextSpaces.key,
      memoryContextSpaces.displayName,
    )
    .orderBy(desc(memoryDocuments.updatedAt))
    .limit(args.limit)
    .offset((args.page - 1) * args.limit);
  const pageCount = totalPages(total, args.limit);
  return {
    documents: rows.map((row) => {
      return {
        id: row.id,
        status: row.status,
        title: row.title,
        provider: row.provider,
        sourceType: row.sourceType,
        externalId: row.externalId,
        contentHash: row.contentHash,
        occurredAt: serializeDate(row.occurredAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        chunkCount: Number(row.chunkCount),
        contextSpace: {
          id: row.contextSpaceId,
          type: row.contextSpaceType,
          key: row.contextSpaceKey,
          displayName: row.contextSpaceDisplayName,
        },
        citationUrl: row.metadata.externalUrl ?? null,
      };
    }),
    pagination: {
      page: args.page,
      pageSize: args.limit,
      total,
      totalPages: pageCount,
      hasMore: args.page < pageCount,
    },
  };
}

export async function listMemoryHistory(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly targetKind: MemoryVersionTargetKind;
    readonly targetId: string;
    readonly limit: number;
  },
): Promise<MemoryHistoryResponse> {
  const rows = await db
    .select({
      id: memoryVersions.id,
      targetKind: memoryVersions.targetKind,
      targetId: memoryVersions.targetId,
      version: memoryVersions.version,
      contentHash: memoryVersions.contentHash,
      metadata: memoryVersions.metadata,
      createdAt: memoryVersions.createdAt,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
    })
    .from(memoryVersions)
    .leftJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryVersions.contextSpaceId),
    )
    .where(
      and(
        eq(memoryVersions.orgId, args.orgId),
        eq(memoryVersions.userId, args.userId),
        eq(memoryVersions.targetKind, args.targetKind),
        eq(memoryVersions.targetId, args.targetId),
      ),
    )
    .orderBy(desc(memoryVersions.version))
    .limit(args.limit);
  return {
    history: rows.map((row) => {
      return {
        id: row.id,
        targetKind: row.targetKind,
        targetId: row.targetId,
        version: row.version,
        contentHash: row.contentHash,
        operation: row.metadata.operation ?? null,
        reason: row.metadata.reason ?? null,
        text: row.metadata.text ?? null,
        title: row.metadata.title ?? null,
        status: row.metadata.status ?? null,
        confidence: row.metadata.confidence ?? null,
        kind: row.metadata.kind ?? null,
        contextSpace: contextSpaceResponse({
          id: row.contextSpaceId,
          type: row.contextSpaceType,
          key: row.contextSpaceKey,
          displayName: row.contextSpaceDisplayName,
        }),
        createdAt: row.createdAt.toISOString(),
      };
    }),
  };
}

export async function listForgottenMemory(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly targetKind?: MemoryTombstoneTargetKind;
    readonly limit: number;
  },
): Promise<MemoryTombstoneListResponse> {
  const filters = [
    eq(memoryTombstones.orgId, args.orgId),
    eq(memoryTombstones.userId, args.userId),
  ];
  if (args.targetKind) {
    filters.push(eq(memoryTombstones.targetKind, args.targetKind));
  }
  const rows = await db
    .select({
      fingerprint: memoryTombstones.fingerprint,
    })
    .from(memoryTombstones)
    .where(and(...filters))
    .orderBy(desc(memoryTombstones.createdAt))
    .limit(args.limit);
  const forgotten = await listInsertedTombstones(db, {
    ...args,
    fingerprints: rows.map((row) => {
      return row.fingerprint;
    }),
  });
  return { forgotten: [...forgotten] };
}

export async function listMemoryProfiles(
  db: ReadonlyDb,
  args: MemoryScope & { readonly limit: number },
): Promise<MemoryProfileListResponse> {
  const rows = await db
    .select({
      id: memoryProfiles.id,
      section: memoryProfiles.section,
      content: memoryProfiles.content,
      sourceMemoryCount: memoryProfiles.sourceMemoryCount,
      createdAt: memoryProfiles.createdAt,
      updatedAt: memoryProfiles.updatedAt,
      entityId: memoryEntities.id,
      entityType: memoryEntities.type,
      entityDisplayName: memoryEntities.displayName,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
    })
    .from(memoryProfiles)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memoryProfiles.entityId))
    .leftJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryProfiles.contextSpaceId),
    )
    .where(
      and(
        eq(memoryProfiles.orgId, args.orgId),
        eq(memoryProfiles.userId, args.userId),
      ),
    )
    .orderBy(desc(memoryProfiles.updatedAt))
    .limit(args.limit);
  return {
    profiles: rows.map((row) => {
      return {
        id: row.id,
        section: row.section,
        content: row.content,
        sourceMemoryCount: row.sourceMemoryCount,
        entity: {
          id: row.entityId,
          type: row.entityType,
          displayName: row.entityDisplayName,
        },
        contextSpace: contextSpaceResponse({
          id: row.contextSpaceId,
          type: row.contextSpaceType,
          key: row.contextSpaceKey,
          displayName: row.contextSpaceDisplayName,
        }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  };
}
