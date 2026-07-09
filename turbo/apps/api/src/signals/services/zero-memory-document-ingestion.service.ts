import {
  memoryContextSpaces,
  memoryDocumentChunks,
  memoryDocuments,
  memoryDocumentSearchEntries,
  memorySources,
  memoryVersions,
  type MemoryContextSpaceMetadata,
  type MemoryContextSpaceType,
  type MemoryDocumentChunkCitation,
  type MemoryDocumentMetadata,
  type MemoryProvider,
  type MemorySourceType,
} from "@vm0/db/schema/memory-substrate";
import { and, desc, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  memoryContentHash,
  memorySubstrateEnabled,
} from "./memory-substrate.service";
import {
  embedZeroMemoryText,
  memoryEmbeddingContentHash,
} from "./zero-memory-embedding.service";

const log = logger("zero-memory-document-ingestion");
const MAX_CHUNK_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 180;

type MemoryContextSpaceRow = typeof memoryContextSpaces.$inferSelect;
type MemoryDocumentRow = typeof memoryDocuments.$inferSelect;
type MemorySourceRow = typeof memorySources.$inferSelect;

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface MemoryContextSpaceInput {
  readonly type: MemoryContextSpaceType;
  readonly key: string;
  readonly displayName: string;
  readonly metadata?: MemoryContextSpaceMetadata;
}

interface MemoryDocumentIngestionInput extends MemoryScope {
  readonly provider: MemoryProvider;
  readonly sourceType: MemorySourceType;
  readonly externalId: string;
  readonly title?: string | null;
  readonly content: string;
  readonly occurredAt?: Date | null;
  readonly contextSpace?: MemoryContextSpaceInput;
  readonly metadata?: MemoryDocumentMetadata;
  readonly citation?: Partial<MemoryDocumentChunkCitation>;
}

interface DocumentChunkInput {
  readonly chunkIndex: number;
  readonly text: string;
  readonly contentHash: string;
  readonly tokenCount: number;
}

interface PreparedMemoryDocument {
  readonly normalizedContent: string;
  readonly chunks: readonly DocumentChunkInput[];
  readonly title: string | null;
  readonly contentHash: string;
  readonly metadata: MemoryDocumentMetadata;
}

function normalizeDocumentText(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      return line.trimEnd();
    })
    .join("\n")
    .trim();
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function nextChunkBoundary(
  text: string,
  start: number,
  maxEnd: number,
): number {
  if (maxEnd >= text.length) {
    return text.length;
  }
  const newline = text.lastIndexOf("\n", maxEnd);
  if (newline > start + MAX_CHUNK_CHARS * 0.5) {
    return newline;
  }
  const space = text.lastIndexOf(" ", maxEnd);
  if (space > start + MAX_CHUNK_CHARS * 0.5) {
    return space;
  }
  return maxEnd;
}

function chunkMemoryDocumentText(content: string): readonly string[] {
  const text = normalizeDocumentText(content);
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = nextChunkBoundary(
      text,
      start,
      Math.min(text.length, start + MAX_CHUNK_CHARS),
    );
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

function defaultContextSpace(args: MemoryScope): MemoryContextSpaceInput {
  return {
    type: "user",
    key: args.userId,
    displayName: "User memory",
    metadata: {
      reason: "Default context space for user-scoped memory ingestion",
    },
  };
}

async function upsertMemoryContextSpace(
  db: Db,
  args: MemoryScope & MemoryContextSpaceInput,
): Promise<MemoryContextSpaceRow> {
  const currentTime = nowDate();
  const values: typeof memoryContextSpaces.$inferInsert = {
    orgId: args.orgId,
    userId: args.userId,
    type: args.type,
    key: args.key,
    displayName: args.displayName,
    metadata: args.metadata ?? {},
    createdAt: currentTime,
    updatedAt: currentTime,
  };

  const [row] = await db
    .insert(memoryContextSpaces)
    .values(values)
    .onConflictDoUpdate({
      target: [
        memoryContextSpaces.orgId,
        memoryContextSpaces.userId,
        memoryContextSpaces.type,
        memoryContextSpaces.key,
      ],
      set: {
        displayName: values.displayName,
        metadata: values.metadata,
        updatedAt: currentTime,
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert memory context space");
  }
  return row;
}

async function loadMemorySource(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly provider: MemoryProvider;
    readonly externalId: string;
  },
): Promise<MemorySourceRow | null> {
  const [row] = await db
    .select()
    .from(memorySources)
    .where(
      and(
        eq(memorySources.orgId, args.orgId),
        eq(memorySources.userId, args.userId),
        eq(memorySources.provider, args.provider),
        eq(memorySources.externalId, args.externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadMemoryDocument(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly provider: MemoryProvider;
    readonly externalId: string;
  },
): Promise<MemoryDocumentRow | null> {
  const [row] = await db
    .select()
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.orgId, args.orgId),
        eq(memoryDocuments.userId, args.userId),
        eq(memoryDocuments.provider, args.provider),
        eq(memoryDocuments.externalId, args.externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function buildDocumentChunks(content: string): readonly DocumentChunkInput[] {
  return chunkMemoryDocumentText(content).map((text, index) => {
    return {
      chunkIndex: index,
      text,
      contentHash: memoryContentHash(text),
      tokenCount: estimateTokenCount(text),
    };
  });
}

function buildCitation(
  args: MemoryDocumentIngestionInput & {
    readonly title: string | null;
    readonly sourceId: string | null;
  },
): MemoryDocumentChunkCitation {
  return {
    provider: args.provider,
    sourceId: args.sourceId ?? "",
    externalId: args.externalId,
    title: args.title,
    url: args.citation?.url ?? args.metadata?.externalUrl ?? null,
    locator: args.citation?.locator ?? null,
    occurredAt: args.occurredAt?.toISOString() ?? null,
  };
}

function prepareMemoryDocument(
  args: MemoryDocumentIngestionInput,
): PreparedMemoryDocument | null {
  const normalizedContent = normalizeDocumentText(args.content);
  const chunks = buildDocumentChunks(normalizedContent);
  if (chunks.length === 0) {
    return null;
  }
  return {
    normalizedContent,
    chunks,
    title: args.title ?? null,
    contentHash: memoryContentHash(normalizedContent),
    metadata: {
      ...args.metadata,
      provider: args.provider,
      sourceType: args.sourceType,
      externalUrl: args.metadata?.externalUrl ?? args.citation?.url ?? null,
    },
  };
}

async function nextDocumentVersion(
  db: ReadonlyDb,
  args: {
    readonly documentId: string;
  },
): Promise<number> {
  const [row] = await db
    .select({ version: memoryVersions.version })
    .from(memoryVersions)
    .where(
      and(
        eq(memoryVersions.targetKind, "document"),
        eq(memoryVersions.targetId, args.documentId),
      ),
    )
    .orderBy(desc(memoryVersions.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}

async function recordDocumentVersion(
  db: Db,
  args: MemoryScope & {
    readonly contextSpaceId: string;
    readonly documentId: string;
    readonly contentHash: string;
    readonly version: number;
    readonly operation: "create" | "update";
  },
): Promise<void> {
  await db
    .insert(memoryVersions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      contextSpaceId: args.contextSpaceId,
      targetKind: "document",
      targetId: args.documentId,
      version: args.version,
      contentHash: args.contentHash,
      metadata: {
        operation: args.operation,
        reason: "Canonical document ingestion",
      },
      createdAt: nowDate(),
    })
    .onConflictDoNothing();
}

async function trySyncMemoryDocumentSearchEntriesForDocument(
  db: Db,
  args: MemoryScope & { readonly documentId: string },
): Promise<void> {
  const chunks = await db
    .select({
      id: memoryDocumentChunks.id,
      orgId: memoryDocumentChunks.orgId,
      userId: memoryDocumentChunks.userId,
      contextSpaceId: memoryDocumentChunks.contextSpaceId,
      documentId: memoryDocumentChunks.documentId,
      status: memoryDocumentChunks.status,
      text: memoryDocumentChunks.text,
    })
    .from(memoryDocumentChunks)
    .where(
      and(
        eq(memoryDocumentChunks.orgId, args.orgId),
        eq(memoryDocumentChunks.userId, args.userId),
        eq(memoryDocumentChunks.documentId, args.documentId),
        eq(memoryDocumentChunks.status, "active"),
      ),
    );

  for (const chunk of chunks) {
    const embeddedResult = await settle(embedZeroMemoryText(chunk.text));
    if (!embeddedResult.ok) {
      log.warn("Failed to embed zero memory document chunk", {
        error: embeddedResult.error,
        documentId: args.documentId,
        chunkId: chunk.id,
      });
      continue;
    }
    const embedded = embeddedResult.value;
    if (!embedded) {
      continue;
    }

    const currentTime = nowDate();
    const values: typeof memoryDocumentSearchEntries.$inferInsert = {
      orgId: chunk.orgId,
      userId: chunk.userId,
      contextSpaceId: chunk.contextSpaceId,
      documentId: chunk.documentId,
      chunkId: chunk.id,
      status: chunk.status,
      text: chunk.text,
      embedding: embedded.embedding,
      embeddingModel: embedded.model,
      contentHash: memoryEmbeddingContentHash({
        model: embedded.model,
        text: chunk.text,
      }),
      createdAt: currentTime,
      updatedAt: currentTime,
    };

    await db
      .insert(memoryDocumentSearchEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [
          memoryDocumentSearchEntries.chunkId,
          memoryDocumentSearchEntries.embeddingModel,
        ],
        set: {
          status: values.status,
          text: values.text,
          embedding: values.embedding,
          contentHash: values.contentHash,
          updatedAt: currentTime,
        },
      });
  }
}

async function upsertMemoryDocument(
  db: Db,
  args: MemoryDocumentIngestionInput & {
    readonly contextSpaceId: string;
    readonly source: MemorySourceRow | null;
    readonly prepared: PreparedMemoryDocument;
    readonly currentTime: Date;
  },
): Promise<MemoryDocumentRow> {
  const occurredAt = args.occurredAt ?? args.source?.occurredAt ?? null;
  const [document] = await db
    .insert(memoryDocuments)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      contextSpaceId: args.contextSpaceId,
      sourceId: args.source?.id ?? null,
      provider: args.provider,
      sourceType: args.sourceType,
      externalId: args.externalId,
      status: "active",
      title: args.prepared.title,
      contentHash: args.prepared.contentHash,
      occurredAt,
      metadata: args.prepared.metadata,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: [
        memoryDocuments.orgId,
        memoryDocuments.userId,
        memoryDocuments.provider,
        memoryDocuments.externalId,
      ],
      set: {
        contextSpaceId: args.contextSpaceId,
        sourceId: args.source?.id ?? null,
        sourceType: args.sourceType,
        status: "active",
        title: args.prepared.title,
        contentHash: args.prepared.contentHash,
        occurredAt,
        metadata: args.prepared.metadata,
        updatedAt: args.currentTime,
      },
    })
    .returning();

  if (!document) {
    throw new Error("Failed to upsert memory document");
  }
  return document;
}

async function syncMemorySourceContextSpace(
  db: Db,
  args: {
    readonly source: MemorySourceRow | null;
    readonly contextSpaceId: string;
    readonly currentTime: Date;
  },
): Promise<void> {
  if (!args.source || args.source.contextSpaceId === args.contextSpaceId) {
    return;
  }
  await db
    .update(memorySources)
    .set({
      contextSpaceId: args.contextSpaceId,
      updatedAt: args.currentTime,
    })
    .where(eq(memorySources.id, args.source.id));
}

async function replaceMemoryDocumentChunks(
  db: Db,
  args: MemoryDocumentIngestionInput & {
    readonly documentId: string;
    readonly contextSpaceId: string;
    readonly source: MemorySourceRow | null;
    readonly prepared: PreparedMemoryDocument;
    readonly currentTime: Date;
  },
): Promise<void> {
  await db
    .delete(memoryDocumentChunks)
    .where(eq(memoryDocumentChunks.documentId, args.documentId));

  const citation = buildCitation({
    ...args,
    title: args.prepared.title,
    sourceId: args.source?.id ?? null,
  });
  await db.insert(memoryDocumentChunks).values(
    args.prepared.chunks.map((chunk) => {
      return {
        orgId: args.orgId,
        userId: args.userId,
        contextSpaceId: args.contextSpaceId,
        documentId: args.documentId,
        sourceId: args.source?.id ?? null,
        status: "active" as const,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        contentHash: chunk.contentHash,
        tokenCount: chunk.tokenCount,
        citation,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      };
    }),
  );
}

export async function recordMemoryDocumentFromConnectorSource(
  db: Db,
  args: MemoryDocumentIngestionInput,
): Promise<boolean> {
  if (!(await memorySubstrateEnabled(db, args))) {
    return false;
  }

  const prepared = prepareMemoryDocument(args);
  if (!prepared) {
    return false;
  }

  const contextSpace = await upsertMemoryContextSpace(db, {
    ...args,
    ...(args.contextSpace ?? defaultContextSpace(args)),
  });
  const source = await loadMemorySource(db, args);
  const currentTime = nowDate();
  const existingDocument = await loadMemoryDocument(db, args);
  const document = await upsertMemoryDocument(db, {
    ...args,
    contextSpaceId: contextSpace.id,
    source,
    prepared,
    currentTime,
  });

  await syncMemorySourceContextSpace(db, {
    source,
    contextSpaceId: contextSpace.id,
    currentTime,
  });

  if (existingDocument?.contentHash === prepared.contentHash) {
    return true;
  }

  const version = await nextDocumentVersion(db, { documentId: document.id });
  await replaceMemoryDocumentChunks(db, {
    ...args,
    contextSpaceId: contextSpace.id,
    documentId: document.id,
    source,
    prepared,
    currentTime,
  });

  await recordDocumentVersion(db, {
    orgId: args.orgId,
    userId: args.userId,
    contextSpaceId: contextSpace.id,
    documentId: document.id,
    contentHash: prepared.contentHash,
    version,
    operation: version === 1 ? "create" : "update",
  });

  await trySyncMemoryDocumentSearchEntriesForDocument(db, {
    orgId: args.orgId,
    userId: args.userId,
    documentId: document.id,
  });

  return true;
}
