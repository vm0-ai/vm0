import type {
  MemoryInjectionItem,
  MemoryRecallItem,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  type MemoryKind,
  memories,
  memoryEdges,
  memoryEntities,
  memoryEntityAliases,
  memoryProfiles,
  memorySearchEntries,
  memorySourceLinks,
  memorySources,
} from "@vm0/db/schema/memory-substrate";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  embedZeroMemoryText,
  type LoadedMemoryEmbedding,
  type MemoryEmbeddingCacheResult,
  type MemoryEmbeddingLoader,
  type MemoryEmbeddingResult,
  memoryEmbeddingSqlLiteral,
} from "./zero-memory-embedding.service";
import {
  measureZeroMemoryTiming,
  type ZeroMemoryTimingDimensions,
  type ZeroMemoryTimingObserver,
  type ZeroMemoryTimingStage,
  zeroMemoryCountBucket,
} from "./zero-memory-timing.service";

const log = logger("zero-memory-profile");
const SEMANTIC_SCORE_THRESHOLD = 0.24;
const EXACT_IDENTITY_LIMIT = 8;
const EXACT_IDENTITY_ALIAS_SCORE = 0.88;

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface ZeroMemoryProfileItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly confidence: number;
  readonly lastSeenAt: Date;
  readonly entity: {
    readonly id: string;
    readonly type: MemoryInjectionItem["entity"]["type"];
    readonly displayName: string;
    readonly primaryEmail: string | null;
    readonly domain: string | null;
  };
  readonly relationship: {
    readonly relationshipType: string | null;
    readonly status: MemoryRecallItem["relationship"]["status"];
    readonly summary: string | null;
    readonly lastInteractionAt: Date | null;
  };
  readonly sources: MemoryRecallItem["sources"];
}

interface ZeroMemoryProfileResult {
  readonly profile: {
    readonly static: readonly ZeroMemoryProfileItem[];
    readonly dynamic: readonly ZeroMemoryProfileItem[];
  };
  readonly searchResults: readonly ZeroMemoryProfileItem[];
}

interface ProfileParams extends MemoryScope {
  readonly query?: string;
  readonly staticKinds: readonly MemoryKind[];
  readonly dynamicKinds: readonly MemoryKind[];
  readonly searchKinds: readonly MemoryKind[];
  readonly staticLimit: number;
  readonly dynamicLimit: number;
  readonly searchLimit: number;
  readonly includeGraphExpansion: boolean;
  readonly entityTypes?: readonly MemoryInjectionItem["entity"]["type"][];
  readonly timing?: ZeroMemoryTimingObserver;
  readonly semanticEmbeddingLoader?: MemoryEmbeddingLoader;
}

interface SearchParams extends MemoryScope {
  readonly query?: string;
  readonly kinds: readonly MemoryKind[];
  readonly limit: number;
  readonly includeGraphExpansion: boolean;
  readonly entityTypes?: readonly MemoryInjectionItem["entity"]["type"][];
  readonly timing?: ZeroMemoryTimingObserver;
  readonly semanticEmbeddingLoader?: MemoryEmbeddingLoader;
}

interface CandidateScore {
  readonly id: string;
  readonly semanticScore: number;
  readonly lexicalScore: number;
  readonly entityScore: number;
  readonly expansionScore: number;
}

type MemoryProfileRow = Omit<ZeroMemoryProfileItem, "sources">;
type MemoryProfilePhase = "static" | "dynamic" | "search";

interface ExactIdentityAlias {
  readonly aliasType: "email" | "domain";
  readonly aliasValue: string;
}

const relationshipEmailAliases = alias(
  memoryEntityAliases,
  "profile_relationship_email_aliases",
);
const relationshipDomainAliases = alias(
  memoryEntityAliases,
  "profile_relationship_domain_aliases",
);
const relationshipTypeProfiles = alias(
  memoryProfiles,
  "profile_relationship_type_profiles",
);
const relationshipStatusProfiles = alias(
  memoryProfiles,
  "profile_relationship_status_profiles",
);
const relationshipSummaryProfiles = alias(
  memoryProfiles,
  "profile_relationship_summary_profiles",
);
const relationshipLastInteractionProfiles = alias(
  memoryProfiles,
  "profile_relationship_last_interaction_profiles",
);
function countDimension(
  dimensionName: string,
  count: number,
): ZeroMemoryTimingDimensions {
  return {
    [dimensionName]: zeroMemoryCountBucket(count),
  };
}

async function measureMemoryList<T>(
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
        ...countDimension(dimensionName, count),
      };
    },
  );
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function parseProfileDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function emailDomain(value: string | null): string | null {
  const domain = value?.split("@")[1]?.trim().toLowerCase();
  return domain && domain.length > 0 ? domain : null;
}

function relationshipStatus(
  value: string | null,
): MemoryRecallItem["relationship"]["status"] {
  return value === "active" || value === "quiet" || value === "archived"
    ? value
    : null;
}

function lower(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
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

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._%+-]+/u)
    .map((token) => {
      return token.trim();
    })
    .filter((token) => {
      return token.length >= 2;
    });
}

function containsQuery(value: string | null, query: string): boolean {
  const normalizedValue = lower(value);
  return normalizedValue.length > 0 && normalizedValue.includes(query);
}

function tokenMatchScore(
  values: readonly (string | null)[],
  tokens: readonly string[],
): number {
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = values.map(lower).join("\n");
  const matched = tokens.filter((token) => {
    return haystack.includes(token);
  }).length;
  return matched / tokens.length;
}

function literalScore(
  row: MemoryProfileRow,
  normalizedQuery: string,
  queryTokens: readonly string[],
): number {
  if (containsQuery(row.text, normalizedQuery)) {
    return 1;
  }
  if (containsQuery(row.entity.displayName, normalizedQuery)) {
    return 0.92;
  }
  if (
    containsQuery(row.entity.primaryEmail, normalizedQuery) ||
    containsQuery(row.entity.domain, normalizedQuery)
  ) {
    return 0.88;
  }
  if (containsQuery(row.relationship.summary, normalizedQuery)) {
    return 0.76;
  }
  if (containsQuery(row.relationship.relationshipType, normalizedQuery)) {
    return 0.68;
  }
  return tokenMatchScore(
    [
      row.text,
      row.entity.displayName,
      row.entity.primaryEmail,
      row.entity.domain,
      row.relationship.summary,
      row.relationship.relationshipType,
    ],
    queryTokens,
  );
}

function exactIdentityAliases(query: string): readonly ExactIdentityAlias[] {
  const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;
  const domainPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
  const aliases: ExactIdentityAlias[] = [];
  const seen = new Set<string>();

  for (const rawToken of query.split(/[^\p{L}\p{N}@._%+-]+/u)) {
    const token = rawToken.replace(/\.+$/u, "");
    const aliasType = emailPattern.test(token)
      ? "email"
      : domainPattern.test(token)
        ? "domain"
        : null;
    if (!aliasType) {
      continue;
    }
    const key = `${aliasType}:${token}`;
    if (seen.has(key)) {
      continue;
    }
    aliases.push({ aliasType, aliasValue: token });
    seen.add(key);
    if (aliases.length === EXACT_IDENTITY_LIMIT) {
      break;
    }
  }
  return aliases;
}

function entityScore(row: MemoryProfileRow, normalizedQuery: string): number {
  const values = [
    row.entity.displayName,
    row.entity.primaryEmail,
    row.entity.domain,
  ].map(lower);
  if (
    values.some((value) => {
      return value.length > 0 && value === normalizedQuery;
    })
  ) {
    return 1;
  }
  if (
    values.some((value) => {
      return (
        value.length > 0 &&
        (value.includes(normalizedQuery) || normalizedQuery.includes(value))
      );
    })
  ) {
    return 0.78;
  }
  return 0;
}

function kindScore(kind: MemoryKind, normalizedQuery: string): number {
  const openLoopHints = [
    "todo",
    "follow",
    "pending",
    "need",
    "next",
    "open loop",
    "待办",
    "跟进",
    "处理",
  ];
  const preferenceHints = [
    "prefer",
    "preference",
    "style",
    "like",
    "偏好",
    "喜欢",
    "习惯",
  ];
  if (
    kind === "open_loop" &&
    openLoopHints.some((hint) => {
      return normalizedQuery.includes(hint);
    })
  ) {
    return 1;
  }
  if (
    (kind === "preference" || kind === "communication_style") &&
    preferenceHints.some((hint) => {
      return normalizedQuery.includes(hint);
    })
  ) {
    return 1;
  }
  switch (kind) {
    case "preference": {
      return 0.88;
    }
    case "open_loop": {
      return 0.84;
    }
    case "communication_style": {
      return 0.8;
    }
    case "recent_context": {
      return 0.72;
    }
    case "key_fact": {
      return 0.68;
    }
    case "role":
    case "project": {
      return 0.55;
    }
  }
}

function freshnessScore(lastSeenAt: Date): number {
  const ageMs = Math.max(0, nowDate().getTime() - lastSeenAt.getTime());
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 90);
}

function compositeScore(
  row: MemoryProfileRow,
  candidate: CandidateScore,
  normalizedQuery: string,
): number {
  return (
    candidate.semanticScore * 0.4 +
    candidate.lexicalScore * 0.24 +
    entityScore(row, normalizedQuery) * 0.14 +
    candidate.entityScore * 0.06 +
    kindScore(row.kind, normalizedQuery) * 0.08 +
    (row.confidence / 100) * 0.04 +
    freshnessScore(row.lastSeenAt) * 0.04 +
    candidate.expansionScore * 0.12
  );
}

function mergeCandidate(
  candidates: Map<string, CandidateScore>,
  next: CandidateScore,
): void {
  const existing = candidates.get(next.id);
  if (!existing) {
    candidates.set(next.id, next);
    return;
  }
  candidates.set(next.id, {
    id: next.id,
    semanticScore: Math.max(existing.semanticScore, next.semanticScore),
    lexicalScore: Math.max(existing.lexicalScore, next.lexicalScore),
    entityScore: Math.max(existing.entityScore, next.entityScore),
    expansionScore: Math.max(existing.expansionScore, next.expansionScore),
  });
}

function memoryKindRank(): SQL {
  return sql`
    case ${memories.kind}
      when 'preference' then 0
      when 'communication_style' then 1
      when 'open_loop' then 2
      when 'recent_context' then 3
      when 'key_fact' then 4
      when 'role' then 5
      when 'project' then 6
      else 7
    end
  `;
}

function baseMemoryFilters(args: {
  readonly scope: MemoryScope;
  readonly kinds: readonly MemoryKind[];
  readonly entityTypes?: readonly MemoryInjectionItem["entity"]["type"][];
}): readonly SQL[] {
  const filters: SQL[] = [
    eq(memories.orgId, args.scope.orgId),
    eq(memories.userId, args.scope.userId),
    eq(memories.status, "active"),
    inArray(memories.kind, [...args.kinds]),
  ];
  if (args.entityTypes) {
    filters.push(inArray(memoryEntities.type, [...args.entityTypes]));
  }
  return filters;
}

function sourceMetadataValue(
  metadata: unknown,
  key: "threadId" | "messageId" | "messageTs",
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

async function loadSourcesByMemoryId(
  db: ReadonlyDb,
  scope: MemoryScope,
  memoryIds: readonly string[],
): Promise<ReadonlyMap<string, MemoryRecallItem["sources"]>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: memorySourceLinks.id,
      memoryId: memorySourceLinks.memoryId,
      provider: memorySources.provider,
      externalId: memorySources.externalId,
      metadata: memorySources.metadata,
      occurredAt: memorySources.occurredAt,
    })
    .from(memorySourceLinks)
    .innerJoin(memorySources, eq(memorySources.id, memorySourceLinks.sourceId))
    .where(
      and(
        eq(memorySourceLinks.orgId, scope.orgId),
        eq(memorySourceLinks.userId, scope.userId),
        inArray(memorySourceLinks.memoryId, [...memoryIds]),
      ),
    )
    .orderBy(desc(memorySources.occurredAt));

  const sourcesByMemoryId = new Map<string, MemoryRecallItem["sources"]>();
  for (const row of rows) {
    const bucket = sourcesByMemoryId.get(row.memoryId) ?? [];
    bucket.push({
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      threadId: sourceMetadataValue(row.metadata, "threadId"),
      messageId:
        sourceMetadataValue(row.metadata, "messageId") ??
        sourceMetadataValue(row.metadata, "messageTs"),
      quote: null,
      occurredAt: serializeDate(row.occurredAt),
    });
    sourcesByMemoryId.set(row.memoryId, bucket);
  }
  return sourcesByMemoryId;
}

async function loadRowsByIds(
  db: ReadonlyDb,
  scope: MemoryScope,
  ids: readonly string[],
): Promise<ReadonlyMap<string, MemoryProfileRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      text: memories.text,
      confidence: memories.confidence,
      lastSeenAt: memories.lastSeenAt,
      entityId: memoryEntities.id,
      entityType: memoryEntities.type,
      displayName: memoryEntities.displayName,
      primaryEmail: relationshipEmailAliases.aliasValue,
      domain: relationshipDomainAliases.aliasValue,
      relationshipType: relationshipTypeProfiles.content,
      relationshipStatus: relationshipStatusProfiles.content,
      relationshipSummary: relationshipSummaryProfiles.content,
      relationshipLastInteractionAt:
        relationshipLastInteractionProfiles.content,
    })
    .from(memories)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .leftJoin(
      relationshipEmailAliases,
      and(
        eq(relationshipEmailAliases.entityId, memoryEntities.id),
        eq(relationshipEmailAliases.aliasType, "email"),
      ),
    )
    .leftJoin(
      relationshipDomainAliases,
      and(
        eq(relationshipDomainAliases.entityId, memoryEntities.id),
        eq(relationshipDomainAliases.aliasType, "domain"),
      ),
    )
    .leftJoin(
      relationshipTypeProfiles,
      and(
        eq(relationshipTypeProfiles.entityId, memoryEntities.id),
        eq(relationshipTypeProfiles.section, "relationship_type"),
      ),
    )
    .leftJoin(
      relationshipStatusProfiles,
      and(
        eq(relationshipStatusProfiles.entityId, memoryEntities.id),
        eq(relationshipStatusProfiles.section, "relationship_status"),
      ),
    )
    .leftJoin(
      relationshipSummaryProfiles,
      and(
        eq(relationshipSummaryProfiles.entityId, memoryEntities.id),
        eq(relationshipSummaryProfiles.section, "relationship_summary"),
      ),
    )
    .leftJoin(
      relationshipLastInteractionProfiles,
      and(
        eq(relationshipLastInteractionProfiles.entityId, memoryEntities.id),
        eq(
          relationshipLastInteractionProfiles.section,
          "relationship_last_interaction_at",
        ),
      ),
    )
    .where(
      and(
        eq(memories.orgId, scope.orgId),
        eq(memories.userId, scope.userId),
        eq(memories.status, "active"),
        inArray(memories.id, [...ids]),
      ),
    );

  const rowsById = new Map<string, MemoryProfileRow>();
  for (const row of rows) {
    if (rowsById.has(row.id)) {
      continue;
    }
    const profileLastInteraction = parseProfileDate(
      row.relationshipLastInteractionAt,
    );
    rowsById.set(row.id, {
      id: row.id,
      kind: row.kind,
      text: row.text,
      confidence: row.confidence,
      lastSeenAt: row.lastSeenAt,
      entity: {
        id: row.entityId,
        type: row.entityType,
        displayName: row.displayName,
        primaryEmail: row.primaryEmail,
        domain:
          row.domain ??
          (row.entityType === "person" ? emailDomain(row.primaryEmail) : null),
      },
      relationship: {
        relationshipType: row.relationshipType,
        status: relationshipStatus(row.relationshipStatus),
        summary: row.relationshipSummary,
        lastInteractionAt: profileLastInteraction,
      },
    });
  }
  return rowsById;
}

async function hydrateRows(
  db: ReadonlyDb,
  scope: MemoryScope,
  rows: readonly MemoryProfileRow[],
  args: {
    readonly timing?: ZeroMemoryTimingObserver;
    readonly phase: MemoryProfilePhase;
  },
): Promise<readonly ZeroMemoryProfileItem[]> {
  let hydratedCount = 0;
  return await measureZeroMemoryTiming(
    args.timing,
    "profile_hydrate",
    async () => {
      let sourceCount = 0;
      const sourcesByMemoryId = await measureZeroMemoryTiming(
        args.timing,
        "profile_load_sources",
        async () => {
          const loaded = await loadSourcesByMemoryId(
            db,
            scope,
            rows.map((row) => {
              return row.id;
            }),
          );
          sourceCount = [...loaded.values()].reduce((sum, sources) => {
            return sum + sources.length;
          }, 0);
          return loaded;
        },
        () => {
          return {
            memory_profile_phase: args.phase,
            memory_profile_source_loaded_count_bucket:
              zeroMemoryCountBucket(sourceCount),
          };
        },
      );
      const hydratedRows = rows.map((row) => {
        return {
          ...row,
          sources: sourcesByMemoryId.get(row.id) ?? [],
        };
      });
      hydratedCount = hydratedRows.length;
      return hydratedRows;
    },
    () => {
      return {
        memory_profile_phase: args.phase,
        memory_profile_hydrated_count_bucket:
          zeroMemoryCountBucket(hydratedCount),
      };
    },
  );
}

async function loadProfileWindow(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly kinds: readonly MemoryKind[];
    readonly limit: number;
    readonly entityTypes?: readonly MemoryInjectionItem["entity"]["type"][];
    readonly timing?: ZeroMemoryTimingObserver;
    readonly profilePhase: MemoryProfilePhase;
  },
): Promise<readonly ZeroMemoryProfileItem[]> {
  if (args.limit <= 0 || args.kinds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .where(
      and(
        ...baseMemoryFilters({
          scope: args,
          kinds: args.kinds,
          entityTypes: args.entityTypes,
        }),
      ),
    )
    .orderBy(
      memoryKindRank(),
      desc(memories.confidence),
      desc(memories.lastSeenAt),
    )
    .limit(args.limit);
  const ids = rows.map((row) => {
    return row.id;
  });
  const rowsById = await loadRowsByIds(db, args, ids);
  const orderedRows = ids
    .map((id) => {
      return rowsById.get(id);
    })
    .filter((row): row is MemoryProfileRow => {
      return row !== undefined;
    });
  return await hydrateRows(db, args, orderedRows, {
    timing: args.timing,
    phase: args.profilePhase,
  });
}

async function loadExactIdentityCandidates(
  db: ReadonlyDb,
  args: SearchParams & { readonly aliases: readonly ExactIdentityAlias[] },
): Promise<readonly CandidateScore[]> {
  const identityFilter = or(
    ...args.aliases.map((identity) => {
      return and(
        eq(memoryEntityAliases.aliasType, identity.aliasType),
        eq(memoryEntityAliases.aliasValue, identity.aliasValue),
      );
    }),
  );
  if (!identityFilter) {
    return [];
  }
  const rows = await db
    .select({
      id: memories.id,
    })
    .from(memoryEntityAliases)
    .innerJoin(
      memoryEntities,
      eq(memoryEntities.id, memoryEntityAliases.entityId),
    )
    .innerJoin(memories, eq(memories.entityId, memoryEntities.id))
    .where(
      and(
        ...baseMemoryFilters({
          scope: args,
          kinds: args.kinds,
          entityTypes: args.entityTypes,
        }),
        eq(memoryEntityAliases.orgId, args.orgId),
        eq(memoryEntityAliases.userId, args.userId),
        identityFilter,
      ),
    )
    .orderBy(
      memoryKindRank(),
      desc(memories.confidence),
      desc(memories.lastSeenAt),
    )
    .limit(Math.max(args.limit * 8, 40));

  const candidates = new Map<string, CandidateScore>();
  for (const row of rows) {
    mergeCandidate(candidates, {
      id: row.id,
      semanticScore: 0,
      lexicalScore: EXACT_IDENTITY_ALIAS_SCORE,
      entityScore: 1,
      expansionScore: 0,
    });
  }
  return [...candidates.values()];
}

async function embedQuery(args: {
  readonly query: string;
  readonly loader?: MemoryEmbeddingLoader;
}): Promise<LoadedMemoryEmbedding> {
  const result = await settle(
    args.loader
      ? args.loader(args.query)
      : (async (): Promise<LoadedMemoryEmbedding> => {
          return { embedding: await embedZeroMemoryText(args.query) };
        })(),
  );
  if (result.ok) {
    return result.value;
  }
  log.warn("Failed to embed zero memory query", { error: result.error });
  return { embedding: null };
}

async function loadSemanticQueryEmbedding(
  args: SearchParams & { readonly normalizedQuery: string },
): Promise<MemoryEmbeddingResult | null> {
  let embeddingResult = "empty";
  let cacheResult: MemoryEmbeddingCacheResult | undefined;
  return await measureZeroMemoryTiming(
    args.timing,
    "profile_search_semantic_embedding",
    async () => {
      const loaded = await embedQuery({
        query: args.normalizedQuery,
        loader: args.semanticEmbeddingLoader,
      });
      embeddingResult = loaded.embedding ? "present" : "empty";
      cacheResult = loaded.cacheResult;
      return loaded.embedding;
    },
    () => {
      return {
        memory_profile_semantic_embedding_result: embeddingResult,
        ...(cacheResult
          ? { memory_profile_semantic_embedding_cache_result: cacheResult }
          : {}),
      };
    },
  );
}

async function loadSemanticCandidates(
  db: ReadonlyDb,
  args: SearchParams & { readonly embedded: MemoryEmbeddingResult },
): Promise<readonly CandidateScore[]> {
  return await measureMemoryList(
    args.timing,
    "profile_search_semantic_query",
    "memory_profile_semantic_candidate_count_bucket",
    async () => {
      const queryVector = sql`${memoryEmbeddingSqlLiteral(args.embedded.embedding)}::vector`;
      const distance = sql<number>`${memorySearchEntries.embedding} <=> ${queryVector}`;
      const rows = await db
        .select({
          id: memorySearchEntries.memoryId,
          semanticScore: sql<number>`1 - (${distance})`,
        })
        .from(memorySearchEntries)
        .innerJoin(memories, eq(memories.id, memorySearchEntries.memoryId))
        .innerJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
        .where(
          and(
            eq(memorySearchEntries.orgId, args.orgId),
            eq(memorySearchEntries.userId, args.userId),
            eq(memorySearchEntries.status, "active"),
            eq(memorySearchEntries.embeddingModel, args.embedded.model),
            eq(memorySearchEntries.entryKind, "memory_text"),
            ...baseMemoryFilters({
              scope: args,
              kinds: args.kinds,
              entityTypes: args.entityTypes,
            }),
          ),
        )
        .orderBy(distance)
        .limit(Math.max(args.limit * 10, 80));

      return rows
        .map((row) => {
          return {
            id: row.id,
            semanticScore: clamp01(row.semanticScore),
            lexicalScore: 0,
            entityScore: 0,
            expansionScore: 0,
          };
        })
        .filter((candidate) => {
          return candidate.semanticScore >= SEMANTIC_SCORE_THRESHOLD;
        });
    },
  );
}

async function loadExpansionCandidates(
  db: ReadonlyDb,
  args: SearchParams & { readonly seedRows: readonly MemoryProfileRow[] },
): Promise<readonly CandidateScore[]> {
  if (!args.includeGraphExpansion || args.seedRows.length === 0) {
    return [];
  }
  const seedIds = args.seedRows.map((row) => {
    return row.id;
  });
  const seedEntityIds = [
    ...new Set(
      args.seedRows.map((row) => {
        return row.entity.id;
      }),
    ),
  ];

  const edgeRows = await db
    .select({
      fromMemoryId: memoryEdges.fromMemoryId,
      toMemoryId: memoryEdges.toMemoryId,
      edgeType: memoryEdges.edgeType,
    })
    .from(memoryEdges)
    .where(
      and(
        eq(memoryEdges.orgId, args.orgId),
        eq(memoryEdges.userId, args.userId),
        or(
          inArray(memoryEdges.fromMemoryId, seedIds),
          inArray(memoryEdges.toMemoryId, seedIds),
        ),
      ),
    )
    .limit(seedIds.length * 4);

  const edgeCandidates = edgeRows
    .map((row) => {
      const relatedId = seedIds.includes(row.fromMemoryId)
        ? row.toMemoryId
        : row.fromMemoryId;
      const expansionScore =
        row.edgeType === "extends" || row.edgeType === "updates" ? 0.9 : 0.7;
      return {
        id: relatedId,
        semanticScore: 0,
        lexicalScore: 0,
        entityScore: 0,
        expansionScore,
      };
    })
    .filter((candidate) => {
      return !seedIds.includes(candidate.id);
    });

  const sameEntityRows = await db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .where(
      and(
        ...baseMemoryFilters({
          scope: args,
          kinds: args.kinds,
          entityTypes: args.entityTypes,
        }),
        inArray(memories.entityId, seedEntityIds),
      ),
    )
    .orderBy(
      memoryKindRank(),
      desc(memories.confidence),
      desc(memories.lastSeenAt),
    )
    .limit(Math.max(seedEntityIds.length * 3, 6));

  const candidates = new Map<string, CandidateScore>();
  for (const candidate of edgeCandidates) {
    mergeCandidate(candidates, candidate);
  }
  for (const row of sameEntityRows) {
    if (seedIds.includes(row.id)) {
      continue;
    }
    mergeCandidate(candidates, {
      id: row.id,
      semanticScore: 0,
      lexicalScore: 0,
      entityScore: 0,
      expansionScore: 0.55,
    });
  }
  return [...candidates.values()];
}

async function rankCandidates(
  db: ReadonlyDb,
  args: SearchParams & {
    readonly normalizedQuery: string;
    readonly candidates: readonly CandidateScore[];
  },
): Promise<readonly MemoryProfileRow[]> {
  const candidateIds = args.candidates.map((candidate) => {
    return candidate.id;
  });
  const rowsById = await loadRowsByIds(db, args, candidateIds);
  const queryTokens = tokenize(args.normalizedQuery);
  const ranked = args.candidates
    .map((candidate) => {
      const row = rowsById.get(candidate.id);
      if (!row) {
        return null;
      }
      return {
        row,
        score: compositeScore(
          row,
          {
            ...candidate,
            lexicalScore: Math.max(
              candidate.lexicalScore,
              literalScore(row, args.normalizedQuery, queryTokens),
            ),
          },
          args.normalizedQuery,
        ),
      };
    })
    .filter(
      (
        item,
      ): item is {
        readonly row: MemoryProfileRow;
        readonly score: number;
      } => {
        return item !== null;
      },
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.row.confidence !== left.row.confidence) {
        return right.row.confidence - left.row.confidence;
      }
      return right.row.lastSeenAt.getTime() - left.row.lastSeenAt.getTime();
    });
  return ranked.slice(0, args.limit).map((item) => {
    return item.row;
  });
}

async function loadSearchResults(
  db: ReadonlyDb,
  args: SearchParams,
): Promise<readonly ZeroMemoryProfileItem[]> {
  if (args.limit <= 0 || args.kinds.length === 0) {
    return [];
  }
  const normalizedQuery = lower(args.query ?? "");
  if (!normalizedQuery) {
    return await loadProfileWindow(db, {
      ...args,
      kinds: args.kinds,
      limit: args.limit,
      profilePhase: "search",
    });
  }

  const candidates = new Map<string, CandidateScore>();
  const aliases = exactIdentityAliases(normalizedQuery);
  const [exactIdentityCandidates, embedded] = await Promise.all([
    measureMemoryList(
      args.timing,
      "profile_search_exact_identity",
      "memory_profile_exact_identity_candidate_count_bucket",
      async () => {
        return await loadExactIdentityCandidates(db, {
          ...args,
          aliases,
        });
      },
      {
        memory_profile_exact_identity_query_eligible: String(
          aliases.length > 0,
        ),
      },
    ),
    loadSemanticQueryEmbedding({
      ...args,
      normalizedQuery,
    }),
  ]);
  for (const candidate of exactIdentityCandidates) {
    mergeCandidate(candidates, candidate);
  }
  if (embedded) {
    for (const candidate of await loadSemanticCandidates(db, {
      ...args,
      embedded,
    })) {
      mergeCandidate(candidates, candidate);
    }
  }

  const seedRows = await measureMemoryList(
    args.timing,
    "profile_search_seed_rank",
    "memory_profile_seed_ranked_count_bucket",
    async () => {
      return await rankCandidates(db, {
        ...args,
        normalizedQuery,
        candidates: [...candidates.values()],
        limit: Math.max(args.limit, Math.min(args.limit * 2, 20)),
      });
    },
  );
  const expansionCandidates = await measureMemoryList(
    args.timing,
    "profile_search_graph_expansion",
    "memory_profile_expansion_candidate_count_bucket",
    async () => {
      return await loadExpansionCandidates(db, {
        ...args,
        seedRows,
      });
    },
  );
  for (const candidate of expansionCandidates) {
    mergeCandidate(candidates, candidate);
  }

  const rankedRows = await measureMemoryList(
    args.timing,
    "profile_search_final_rank",
    "memory_profile_final_ranked_count_bucket",
    async () => {
      return await rankCandidates(db, {
        ...args,
        normalizedQuery,
        candidates: [...candidates.values()],
      });
    },
  );
  return await hydrateRows(db, args, rankedRows, {
    timing: args.timing,
    phase: "search",
  });
}

export async function getZeroMemoryProfile(
  db: ReadonlyDb,
  params: ProfileParams,
): Promise<ZeroMemoryProfileResult> {
  const [staticProfile, dynamicProfile, searchResultsRaw] = await Promise.all([
    measureMemoryList(
      params.timing,
      "profile_static",
      "memory_profile_static_result_count_bucket",
      async () => {
        return await loadProfileWindow(db, {
          ...params,
          kinds: params.staticKinds,
          limit: params.staticLimit,
          profilePhase: "static",
        });
      },
    ),
    measureMemoryList(
      params.timing,
      "profile_dynamic",
      "memory_profile_dynamic_result_count_bucket",
      async () => {
        return await loadProfileWindow(db, {
          ...params,
          kinds: params.dynamicKinds,
          limit: params.dynamicLimit,
          profilePhase: "dynamic",
        });
      },
    ),
    measureMemoryList(
      params.timing,
      "profile_search",
      "memory_profile_search_result_count_bucket",
      async () => {
        return await loadSearchResults(db, {
          ...params,
          kinds: params.searchKinds,
          limit: params.searchLimit,
          includeGraphExpansion: params.includeGraphExpansion,
        });
      },
    ),
  ]);

  const profileIds = new Set(
    [...staticProfile, ...dynamicProfile].map((item) => {
      return item.id;
    }),
  );
  const searchResults = searchResultsRaw.filter((item) => {
    return !profileIds.has(item.id);
  });

  return {
    profile: {
      static: staticProfile,
      dynamic: dynamicProfile,
    },
    searchResults,
  };
}

export function toMemoryInjectionItem(
  item: ZeroMemoryProfileItem,
): MemoryInjectionItem {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    confidence: item.confidence,
    lastSeenAt: item.lastSeenAt.toISOString(),
    entity: {
      id: item.entity.id,
      type: item.entity.type,
      displayName: item.entity.displayName,
    },
    sources: item.sources,
  };
}

export function toMemoryRecallItem(
  item: ZeroMemoryProfileItem,
): MemoryRecallItem | null {
  if (
    item.kind !== "key_fact" &&
    item.kind !== "preference" &&
    item.kind !== "open_loop"
  ) {
    return null;
  }
  if (item.entity.type !== "person" && item.entity.type !== "organization") {
    return null;
  }
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    confidence: item.confidence,
    lastSeenAt: item.lastSeenAt.toISOString(),
    relationship: {
      id: item.entity.id,
      entity: {
        id: item.entity.id,
        type: item.entity.type,
        displayName: item.entity.displayName,
        primaryEmail: item.entity.primaryEmail,
        domain: item.entity.domain,
      },
      relationshipType: item.relationship.relationshipType,
      status: item.relationship.status,
      summary: item.relationship.summary,
      lastInteractionAt: serializeDate(item.relationship.lastInteractionAt),
    },
    sources: item.sources,
  };
}
