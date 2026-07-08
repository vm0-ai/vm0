import type {
  MemoryContextResponse,
  MemoryRecallItem,
  MemoryRecallItemKind,
  MemoryRecallResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  memories,
  memoryEntities,
  memoryEntityAliases,
  memoryProfiles,
  memorySourceLinks,
  memorySources,
} from "@vm0/db/schema/memory-substrate";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface RecallParams extends MemoryScope {
  readonly q: string;
  readonly kind?: MemoryRecallItemKind;
  readonly limit: number;
}

interface ContextParams extends MemoryScope {
  readonly q?: string;
  readonly limit: number;
}

type GraphMemoryRecallRow = {
  readonly id: string;
  readonly kind: MemoryRecallItemKind;
  readonly text: string;
  readonly confidence: number;
  readonly lastSeenAt: Date;
  readonly entityId: string;
  readonly entityType: "person" | "organization";
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string | null;
  readonly relationshipStatus: string | null;
  readonly relationshipSummary: string | null;
  readonly relationshipLastInteractionAt: string | null;
};

const RECALL_MEMORY_KINDS = ["key_fact", "preference", "open_loop"] as const;

const relationshipIdentityAliases = alias(
  memoryEntityAliases,
  "relationship_identity_aliases",
);
const emailAliases = alias(memoryEntityAliases, "relationship_email_aliases");
const domainAliases = alias(memoryEntityAliases, "relationship_domain_aliases");
const relationshipTypeProfiles = alias(
  memoryProfiles,
  "relationship_type_profiles",
);
const relationshipStatusProfiles = alias(
  memoryProfiles,
  "relationship_status_profiles",
);
const relationshipSummaryProfiles = alias(
  memoryProfiles,
  "relationship_summary_profiles",
);
const relationshipLastInteractionProfiles = alias(
  memoryProfiles,
  "relationship_last_interaction_profiles",
);

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

function relationshipStatus(
  value: string | null,
): MemoryRecallItem["relationship"]["status"] {
  return value === "active" || value === "quiet" || value === "archived"
    ? value
    : null;
}

function graphQueryFilter(query: string): SQL | undefined {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const pattern = `%${trimmed}%`;
  return or(
    ilike(memories.text, pattern),
    ilike(memoryEntities.displayName, pattern),
    ilike(emailAliases.aliasValue, pattern),
    ilike(domainAliases.aliasValue, pattern),
    ilike(relationshipTypeProfiles.content, pattern),
    ilike(relationshipSummaryProfiles.content, pattern),
  );
}

function graphMemoryFilters(
  scope: MemoryScope,
  options: {
    readonly q?: string;
    readonly kind?: MemoryRecallItemKind;
  },
): SQL[] {
  const filters: SQL[] = [
    eq(memories.orgId, scope.orgId),
    eq(memories.userId, scope.userId),
    eq(memories.status, "active"),
    inArray(memories.kind, [...RECALL_MEMORY_KINDS]),
    sql`${memoryEntities.type} in ('person', 'organization')`,
  ];
  if (options.kind) {
    filters.push(eq(memories.kind, options.kind));
  }
  if (options.q) {
    const filter = graphQueryFilter(options.q);
    if (filter) {
      filters.push(filter);
    }
  }
  return filters;
}

function graphQueryRank(query: string | undefined): SQL {
  if (!query || query.trim().length === 0) {
    return sql`0`;
  }
  const pattern = `%${query.trim()}%`;
  return sql`
    case
      when ${memories.text} ilike ${pattern} then 0
      when ${memoryEntities.displayName} ilike ${pattern} then 1
      when ${relationshipSummaryProfiles.content} ilike ${pattern} then 2
      else 3
    end
  `;
}

function graphKindRank(): SQL {
  return sql`
    case ${memories.kind}
      when 'preference' then 0
      when 'open_loop' then 1
      when 'key_fact' then 2
      else 3
    end
  `;
}

async function loadGraphMemoryRows(
  db: ReadonlyDb,
  params: RecallParams | ContextParams,
): Promise<readonly GraphMemoryRecallRow[]> {
  const filters = graphMemoryFilters(params, {
    q: params.q,
    kind: "kind" in params ? params.kind : undefined,
  });
  const rankingOrder = params.q?.trim() ? [graphQueryRank(params.q)] : [];

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
      primaryEmail: emailAliases.aliasValue,
      domain: domainAliases.aliasValue,
      relationshipType: relationshipTypeProfiles.content,
      relationshipStatus: relationshipStatusProfiles.content,
      relationshipSummary: relationshipSummaryProfiles.content,
      relationshipLastInteractionAt:
        relationshipLastInteractionProfiles.content,
    })
    .from(memories)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memories.entityId))
    .innerJoin(
      relationshipIdentityAliases,
      and(
        eq(relationshipIdentityAliases.entityId, memoryEntities.id),
        eq(relationshipIdentityAliases.aliasType, "relationship_identity"),
      ),
    )
    .leftJoin(
      emailAliases,
      and(
        eq(emailAliases.entityId, memoryEntities.id),
        eq(emailAliases.aliasType, "email"),
      ),
    )
    .leftJoin(
      domainAliases,
      and(
        eq(domainAliases.entityId, memoryEntities.id),
        eq(domainAliases.aliasType, "domain"),
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
    .where(and(...filters))
    .orderBy(
      ...rankingOrder,
      graphKindRank(),
      desc(memories.confidence),
      desc(memories.lastSeenAt),
    )
    .limit(params.limit);

  const dedupedRows: GraphMemoryRecallRow[] = [];
  const seenMemoryIds = new Set<string>();
  for (const row of rows) {
    if (row.entityType !== "organization" && row.entityType !== "person") {
      continue;
    }
    if (seenMemoryIds.has(row.id)) {
      continue;
    }
    seenMemoryIds.add(row.id);
    dedupedRows.push({
      ...row,
      kind: row.kind as MemoryRecallItemKind,
      entityType: row.entityType,
    });
  }
  return dedupedRows;
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

async function loadGraphSourcesByMemoryId(
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

async function hydrateGraphMemories(
  db: ReadonlyDb,
  scope: MemoryScope,
  rows: readonly GraphMemoryRecallRow[],
): Promise<readonly MemoryRecallItem[]> {
  const memoryIds = rows.map((row) => {
    return row.id;
  });
  const sourcesByMemoryId = await loadGraphSourcesByMemoryId(
    db,
    scope,
    memoryIds,
  );

  return rows.map((row) => {
    const profileLastInteraction = parseProfileDate(
      row.relationshipLastInteractionAt,
    );
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      confidence: row.confidence,
      lastSeenAt: row.lastSeenAt.toISOString(),
      relationship: {
        id: row.entityId,
        entity: {
          id: row.entityId,
          type: row.entityType,
          displayName: row.displayName,
          primaryEmail: row.primaryEmail,
          domain: row.domain,
        },
        relationshipType: row.relationshipType,
        status: relationshipStatus(row.relationshipStatus),
        summary: row.relationshipSummary,
        lastInteractionAt: serializeDate(profileLastInteraction),
      },
      sources: sourcesByMemoryId.get(row.id) ?? [],
    };
  });
}

async function loadMemoryItems(
  db: ReadonlyDb,
  params: RecallParams | ContextParams,
): Promise<readonly MemoryRecallItem[]> {
  const graphRows = await loadGraphMemoryRows(db, params);
  return await hydrateGraphMemories(db, params, graphRows);
}

export async function recallZeroMemory(
  db: ReadonlyDb,
  params: RecallParams,
): Promise<MemoryRecallResponse> {
  const memories = await loadMemoryItems(db, params);
  return { query: params.q, memories: [...memories] };
}

function kindLabel(kind: MemoryRecallItemKind): string {
  switch (kind) {
    case "preference": {
      return "Preferences";
    }
    case "open_loop": {
      return "Open loops";
    }
    case "key_fact": {
      return "Key facts";
    }
  }
}

function sourceRef(memory: MemoryRecallItem): string {
  const source = memory.sources[0];
  if (!source) {
    return "";
  }
  return ` [${source.provider}:${source.externalId}]`;
}

function formatMemoryContext(memories: readonly MemoryRecallItem[]): string {
  if (memories.length === 0) {
    return "";
  }

  const lines = ["Structured memory:"];
  for (const kind of ["preference", "open_loop", "key_fact"] as const) {
    const matching = memories.filter((memory) => {
      return memory.kind === kind;
    });
    if (matching.length === 0) {
      continue;
    }
    lines.push("", `${kindLabel(kind)}:`);
    for (const memory of matching) {
      const entity = memory.relationship.entity.displayName;
      lines.push(`- ${memory.text} (${entity})${sourceRef(memory)}`);
    }
  }
  return lines.join("\n");
}

export async function getZeroMemoryContext(
  db: ReadonlyDb,
  params: ContextParams,
): Promise<MemoryContextResponse> {
  const memories = await loadMemoryItems(db, params);
  return {
    query: params.q ?? null,
    context: formatMemoryContext(memories),
    memories: [...memories],
  };
}
