import type {
  MemoryRecallItem,
  MemoryKind,
  MemorySearchMode,
  MemorySearchResponse,
  MemorySearchResult,
  MemorySourceProvider,
  MemorySourceType,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  memoryContextSpaces,
  memoryDocumentChunks,
  memoryDocuments,
  memoryDocumentSearchEntries,
} from "@vm0/db/schema/memory-substrate";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  embedZeroMemoryText,
  memoryEmbeddingSqlLiteral,
} from "./zero-memory-embedding.service";
import { recallZeroMemory } from "./zero-memory-recall.service";
import {
  measureZeroMemoryTiming,
  zeroMemoryCountBucket,
  type ZeroMemoryTimingDimensions,
  type ZeroMemoryTimingObserver,
  type ZeroMemoryTimingStage,
} from "./zero-memory-timing.service";

const log = logger("zero-memory-search");
const SEMANTIC_SCORE_THRESHOLD = 0.2;
const RECIPROCAL_RANK_FUSION_K = 60;
const MAX_CHUNKS_PER_DOCUMENT = 2;

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface SearchParams extends MemoryScope {
  readonly q: string;
  readonly mode: MemorySearchMode;
  readonly provider?: MemorySourceProvider;
  readonly sourceType?: MemorySourceType;
  readonly contextSpaceType?: (typeof memoryContextSpaces.$inferSelect)["type"];
  readonly contextSpaceKey?: string;
  readonly memoryKind?: MemoryKind;
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit: number;
  readonly timing?: ZeroMemoryTimingObserver;
}

interface DocumentCandidate {
  readonly chunkId: string;
  readonly semanticScore: number;
  readonly lexicalScore: number;
  readonly semanticRank: number | null;
  readonly lexicalRank: number | null;
}

type DocumentSearchResult = Extract<
  MemorySearchResult,
  { readonly kind: "document_chunk" }
>;

async function measureDocumentList<T>(
  observer: ZeroMemoryTimingObserver | undefined,
  stage: ZeroMemoryTimingStage,
  dimensionName: string,
  operation: () => readonly T[] | Promise<readonly T[]>,
  dimensions: ZeroMemoryTimingDimensions = {},
): Promise<readonly T[]> {
  let count = 0;
  return await measureZeroMemoryTiming(
    observer,
    stage,
    async () => {
      const result = await operation();
      count = result.length;
      return result;
    },
    () => {
      return {
        ...dimensions,
        [dimensionName]: zeroMemoryCountBucket(count),
      };
    },
  );
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizedQuery(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._-]+/u)
    .map((token) => {
      return token.trim();
    })
    .filter((token) => {
      return token.length >= 2;
    });
}

function tokenMatchScore(
  values: readonly (string | null)[],
  query: string,
): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = values
    .map((value) => {
      return value?.toLowerCase() ?? "";
    })
    .join("\n");
  const matched = tokens.filter((token) => {
    return haystack.includes(token);
  }).length;
  return matched / tokens.length;
}

function freshnessScore(value: Date | null): number {
  if (!value) {
    return 0.3;
  }
  const ageMs = Math.max(0, nowDate().getTime() - value.getTime());
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 180);
}

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / (RECIPROCAL_RANK_FUSION_K + rank);
}

function documentScore(args: {
  readonly semanticRank: number | null;
  readonly lexicalRank: number | null;
  readonly occurredAt: Date | null;
}): number {
  const maximumRankScore = 1 / (RECIPROCAL_RANK_FUSION_K + 1);
  const fusedScore =
    (reciprocalRank(args.semanticRank) + reciprocalRank(args.lexicalRank)) /
    maximumRankScore;
  return clamp01(fusedScore * 0.96 + freshnessScore(args.occurredAt) * 0.04);
}

function mergeDocumentCandidate(
  candidates: Map<string, DocumentCandidate>,
  next: DocumentCandidate,
): void {
  const existing = candidates.get(next.chunkId);
  if (!existing) {
    candidates.set(next.chunkId, next);
    return;
  }
  candidates.set(next.chunkId, {
    chunkId: next.chunkId,
    semanticScore: Math.max(existing.semanticScore, next.semanticScore),
    lexicalScore: Math.max(existing.lexicalScore, next.lexicalScore),
    semanticRank:
      existing.semanticRank === null
        ? next.semanticRank
        : next.semanticRank === null
          ? existing.semanticRank
          : Math.min(existing.semanticRank, next.semanticRank),
    lexicalRank:
      existing.lexicalRank === null
        ? next.lexicalRank
        : next.lexicalRank === null
          ? existing.lexicalRank
          : Math.min(existing.lexicalRank, next.lexicalRank),
  });
}

function documentFilters(args: SearchParams) {
  const filters = [
    eq(memoryDocumentChunks.orgId, args.orgId),
    eq(memoryDocumentChunks.userId, args.userId),
    eq(memoryDocumentChunks.status, "active" as const),
    eq(memoryDocuments.status, "active" as const),
  ];
  if (args.provider) {
    filters.push(eq(memoryDocuments.provider, args.provider));
  }
  if (args.sourceType) {
    filters.push(eq(memoryDocuments.sourceType, args.sourceType));
  }
  if (args.contextSpaceType) {
    filters.push(eq(memoryContextSpaces.type, args.contextSpaceType));
  }
  if (args.contextSpaceKey) {
    filters.push(eq(memoryContextSpaces.key, args.contextSpaceKey));
  }
  if (args.occurredAfter) {
    filters.push(gte(memoryDocuments.occurredAt, new Date(args.occurredAfter)));
  }
  if (args.occurredBefore) {
    filters.push(
      lte(memoryDocuments.occurredAt, new Date(args.occurredBefore)),
    );
  }
  return filters;
}

async function loadLexicalDocumentCandidates(
  db: ReadonlyDb,
  args: SearchParams & { readonly normalizedQuery: string },
): Promise<readonly DocumentCandidate[]> {
  const pattern = `%${args.normalizedQuery}%`;
  const rows = await db
    .select({
      chunkId: memoryDocumentChunks.id,
      text: memoryDocumentChunks.text,
      title: memoryDocuments.title,
      externalId: memoryDocuments.externalId,
      occurredAt: memoryDocuments.occurredAt,
    })
    .from(memoryDocumentChunks)
    .innerJoin(
      memoryDocuments,
      eq(memoryDocuments.id, memoryDocumentChunks.documentId),
    )
    .innerJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryDocumentChunks.contextSpaceId),
    )
    .where(
      and(
        ...documentFilters(args),
        or(
          ilike(memoryDocumentChunks.text, pattern),
          ilike(memoryDocuments.title, pattern),
          ilike(memoryDocuments.externalId, pattern),
        ),
      ),
    )
    .orderBy(desc(memoryDocuments.occurredAt))
    .limit(Math.max(args.limit * 8, 40));

  const rankedRows = rows
    .map((row) => {
      return {
        chunkId: row.chunkId,
        lexicalScore: Math.max(
          row.text.toLowerCase().includes(args.normalizedQuery) ? 1 : 0,
          row.title?.toLowerCase().includes(args.normalizedQuery) ? 0.92 : 0,
          tokenMatchScore([row.text, row.title, row.externalId], args.q),
        ),
      };
    })
    .sort((a, b) => {
      return b.lexicalScore - a.lexicalScore;
    });
  const candidates = new Map<string, DocumentCandidate>();
  for (const [index, row] of rankedRows.entries()) {
    mergeDocumentCandidate(candidates, {
      chunkId: row.chunkId,
      semanticScore: 0,
      lexicalScore: row.lexicalScore,
      semanticRank: null,
      lexicalRank: index + 1,
    });
  }
  return [...candidates.values()];
}

async function embedQuery(query: string) {
  const result = await settle(embedZeroMemoryText(query));
  if (result.ok) {
    return result.value;
  }
  log.warn("Failed to embed zero memory document query", {
    error: result.error,
  });
  return null;
}

async function loadSemanticDocumentCandidates(
  db: ReadonlyDb,
  args: SearchParams & { readonly normalizedQuery: string },
): Promise<readonly DocumentCandidate[]> {
  let embeddingResult = "empty";
  const embedded = await measureZeroMemoryTiming(
    args.timing,
    "document_search_semantic_embedding",
    async () => {
      const result = await embedQuery(args.normalizedQuery);
      embeddingResult = result ? "present" : "empty";
      return result;
    },
    () => {
      return {
        memory_document_semantic_embedding_result: embeddingResult,
      };
    },
  );
  if (!embedded) {
    return [];
  }

  return await measureDocumentList(
    args.timing,
    "document_search_semantic_query",
    "memory_document_semantic_candidate_count_bucket",
    async () => {
      const queryVector = sql`${memoryEmbeddingSqlLiteral(embedded.embedding)}::vector`;
      const distance = sql<number>`${memoryDocumentSearchEntries.embedding} <=> ${queryVector}`;
      const rows = await db
        .select({
          chunkId: memoryDocumentSearchEntries.chunkId,
          semanticScore: sql<number>`1 - (${distance})`,
        })
        .from(memoryDocumentSearchEntries)
        .innerJoin(
          memoryDocumentChunks,
          eq(memoryDocumentChunks.id, memoryDocumentSearchEntries.chunkId),
        )
        .innerJoin(
          memoryDocuments,
          eq(memoryDocuments.id, memoryDocumentSearchEntries.documentId),
        )
        .innerJoin(
          memoryContextSpaces,
          eq(
            memoryContextSpaces.id,
            memoryDocumentSearchEntries.contextSpaceId,
          ),
        )
        .where(
          and(
            eq(memoryDocumentSearchEntries.orgId, args.orgId),
            eq(memoryDocumentSearchEntries.userId, args.userId),
            eq(memoryDocumentSearchEntries.status, "active"),
            eq(memoryDocumentSearchEntries.embeddingModel, embedded.model),
            ...documentFilters(args),
          ),
        )
        .orderBy(distance)
        .limit(Math.max(args.limit * 10, 80));

      return rows
        .map((row, index) => {
          return {
            chunkId: row.chunkId,
            semanticScore: clamp01(row.semanticScore),
            lexicalScore: 0,
            semanticRank: index + 1,
            lexicalRank: null,
          };
        })
        .filter((candidate) => {
          return candidate.semanticScore >= SEMANTIC_SCORE_THRESHOLD;
        });
    },
  );
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function hydrateDocumentResults(
  db: ReadonlyDb,
  args: SearchParams & {
    readonly candidates: readonly DocumentCandidate[];
  },
): Promise<readonly DocumentSearchResult[]> {
  if (args.candidates.length === 0) {
    return [];
  }
  const candidatesByChunkId = new Map(
    args.candidates.map((candidate) => {
      return [candidate.chunkId, candidate] as const;
    }),
  );
  const rows = await db
    .select({
      chunkId: memoryDocumentChunks.id,
      documentId: memoryDocuments.id,
      text: memoryDocumentChunks.text,
      citation: memoryDocumentChunks.citation,
      title: memoryDocuments.title,
      provider: memoryDocuments.provider,
      sourceType: memoryDocuments.sourceType,
      externalId: memoryDocuments.externalId,
      occurredAt: memoryDocuments.occurredAt,
      contextSpaceId: memoryContextSpaces.id,
      contextSpaceType: memoryContextSpaces.type,
      contextSpaceKey: memoryContextSpaces.key,
      contextSpaceDisplayName: memoryContextSpaces.displayName,
    })
    .from(memoryDocumentChunks)
    .innerJoin(
      memoryDocuments,
      eq(memoryDocuments.id, memoryDocumentChunks.documentId),
    )
    .innerJoin(
      memoryContextSpaces,
      eq(memoryContextSpaces.id, memoryDocumentChunks.contextSpaceId),
    )
    .where(
      and(
        ...documentFilters(args),
        inArray(memoryDocumentChunks.id, [
          ...candidatesByChunkId.keys(),
        ] as string[]),
      ),
    );

  const results: DocumentSearchResult[] = [];
  for (const row of rows) {
    const candidate = candidatesByChunkId.get(row.chunkId);
    if (!candidate) {
      continue;
    }
    results.push({
      kind: "document_chunk",
      id: row.chunkId,
      documentId: row.documentId,
      chunkId: row.chunkId,
      title: row.title,
      text: row.text,
      score: documentScore({
        semanticRank: candidate.semanticRank,
        lexicalRank: candidate.lexicalRank,
        occurredAt: row.occurredAt,
      }),
      provider: row.provider,
      sourceType: row.sourceType,
      externalId: row.externalId,
      occurredAt: serializeDate(row.occurredAt),
      contextSpace: {
        id: row.contextSpaceId,
        type: row.contextSpaceType,
        key: row.contextSpaceKey,
        displayName: row.contextSpaceDisplayName,
      },
      citation: {
        provider: row.provider,
        sourceId: row.citation.sourceId,
        externalId: row.citation.externalId,
        title: row.citation.title ?? null,
        url: row.citation.url ?? null,
        locator: row.citation.locator ?? null,
        occurredAt: row.citation.occurredAt ?? null,
      },
    });
  }
  return results
    .sort((a, b) => {
      return b.score - a.score;
    })
    .slice(0, args.limit);
}

async function searchMemoryDocuments(
  db: ReadonlyDb,
  args: SearchParams,
): Promise<readonly DocumentSearchResult[]> {
  return await measureDocumentList(
    args.timing,
    "document_search",
    "memory_document_search_result_count_bucket",
    async () => {
      const query = normalizedQuery(args.q);
      const candidates = new Map<string, DocumentCandidate>();
      const [lexicalCandidates, semanticCandidates] = await Promise.all([
        measureDocumentList(
          args.timing,
          "document_search_lexical",
          "memory_document_lexical_candidate_count_bucket",
          async () => {
            return await loadLexicalDocumentCandidates(db, {
              ...args,
              normalizedQuery: query,
            });
          },
        ),
        loadSemanticDocumentCandidates(db, {
          ...args,
          normalizedQuery: query,
        }),
      ]);
      for (const candidate of [...lexicalCandidates, ...semanticCandidates]) {
        mergeDocumentCandidate(candidates, candidate);
      }
      return await measureDocumentList(
        args.timing,
        "document_search_hydrate",
        "memory_document_hydrated_result_count_bucket",
        async () => {
          return await hydrateDocumentResults(db, {
            ...args,
            candidates: [...candidates.values()],
          });
        },
        {
          memory_document_hydration_candidate_count_bucket:
            zeroMemoryCountBucket(candidates.size),
        },
      );
    },
  );
}

function memoryResultScore(memory: MemoryRecallItem, index: number): number {
  const rankScore = reciprocalRank(index + 1) / reciprocalRank(1);
  return clamp01(
    rankScore * 0.9 +
      (memory.confidence / 100) * 0.07 +
      freshnessScore(new Date(memory.lastSeenAt)) * 0.04 -
      0.01,
  );
}

function normalizedResultText(result: MemorySearchResult): string {
  const text = result.kind === "memory" ? result.memory.text : result.text;
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function dedupeSearchResults(
  results: readonly MemorySearchResult[],
  limit: number,
): readonly MemorySearchResult[] {
  const documentCounts = new Map<string, number>();
  const resultIndexesByText = new Map<string, number>();
  const deduped: MemorySearchResult[] = [];

  for (const result of results) {
    const normalizedText = normalizedResultText(result);
    const existingIndex = normalizedText
      ? resultIndexesByText.get(normalizedText)
      : undefined;
    if (existingIndex !== undefined) {
      const existing = deduped[existingIndex];
      if (existing?.kind === "document_chunk" && result.kind === "memory") {
        const documentCount = documentCounts.get(existing.documentId) ?? 1;
        documentCounts.set(existing.documentId, documentCount - 1);
        deduped[existingIndex] = result;
      }
      continue;
    }
    if (result.kind === "document_chunk") {
      const documentCount = documentCounts.get(result.documentId) ?? 0;
      if (documentCount >= MAX_CHUNKS_PER_DOCUMENT) {
        continue;
      }
      documentCounts.set(result.documentId, documentCount + 1);
    }
    if (normalizedText) {
      resultIndexesByText.set(normalizedText, deduped.length);
    }
    deduped.push(result);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

async function searchMemories(
  db: ReadonlyDb,
  args: SearchParams,
): Promise<readonly MemorySearchResult[]> {
  if (
    args.memoryKind &&
    args.memoryKind !== "key_fact" &&
    args.memoryKind !== "preference" &&
    args.memoryKind !== "open_loop"
  ) {
    return [];
  }
  const response = await recallZeroMemory(db, {
    orgId: args.orgId,
    userId: args.userId,
    q: args.q,
    kind: args.memoryKind,
    limit: args.limit,
  });
  return response.memories.map((memory, index) => {
    return {
      kind: "memory" as const,
      id: memory.id,
      score: memoryResultScore(memory, index),
      memory,
    };
  });
}

export async function searchZeroMemory(
  db: ReadonlyDb,
  args: SearchParams,
): Promise<MemorySearchResponse> {
  const includeMemories = args.mode === "hybrid" || args.mode === "memories";
  const includeDocuments = args.mode === "hybrid" || args.mode === "documents";
  const candidateLimit = Math.max(args.limit * 4, 20);
  const [memoryResults, documentResults] = await Promise.all([
    includeMemories
      ? searchMemories(db, { ...args, limit: candidateLimit })
      : Promise.resolve([]),
    includeDocuments
      ? searchMemoryDocuments(db, { ...args, limit: candidateLimit })
      : Promise.resolve([]),
  ]);
  const rankedResults = [...memoryResults, ...documentResults].sort((a, b) => {
    return b.score - a.score;
  });
  const results = dedupeSearchResults(rankedResults, args.limit);
  return {
    query: args.q,
    mode: args.mode,
    results: [...results],
  };
}
