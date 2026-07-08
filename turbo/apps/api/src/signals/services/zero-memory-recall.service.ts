import type {
  MemoryContextResponse,
  MemoryRecallItem,
  MemoryRecallItemKind,
  MemoryRecallResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  relationshipEntities,
  relationshipItems,
  relationshipItemSources,
  relationshipStates,
} from "@vm0/db/schema/relationship-memory";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

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

type MemoryRecallRow = {
  readonly id: string;
  readonly kind: MemoryRecallItemKind;
  readonly text: string;
  readonly confidence: number;
  readonly lastSeenAt: Date;
  readonly relationshipStateId: string;
  readonly relationshipType: string;
  readonly relationshipStatus: "active" | "quiet" | "archived";
  readonly relationshipSummary: string;
  readonly lastInteractionAt: Date | null;
  readonly entityId: string;
  readonly entityType: "person" | "organization";
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
};

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function queryFilter(query: string): SQL | undefined {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const pattern = `%${trimmed}%`;
  return or(
    ilike(relationshipItems.text, pattern),
    ilike(relationshipEntities.displayName, pattern),
    ilike(relationshipEntities.primaryEmail, pattern),
    ilike(relationshipEntities.domain, pattern),
    ilike(relationshipStates.relationshipType, pattern),
    ilike(relationshipStates.summary, pattern),
  );
}

function memoryFilters(
  scope: MemoryScope,
  options: {
    readonly q?: string;
    readonly kind?: MemoryRecallItemKind;
  },
): SQL[] {
  const filters: SQL[] = [
    eq(relationshipItems.orgId, scope.orgId),
    eq(relationshipItems.userId, scope.userId),
    isNull(relationshipItems.archivedAt),
    ne(relationshipStates.status, "archived"),
  ];
  if (options.kind) {
    filters.push(eq(relationshipItems.kind, options.kind));
  }
  if (options.q) {
    const filter = queryFilter(options.q);
    if (filter) {
      filters.push(filter);
    }
  }
  return filters;
}

function queryRank(query: string | undefined): SQL {
  if (!query || query.trim().length === 0) {
    return sql`0`;
  }
  const pattern = `%${query.trim()}%`;
  return sql`
    case
      when ${relationshipItems.text} ilike ${pattern} then 0
      when ${relationshipEntities.displayName} ilike ${pattern} then 1
      when ${relationshipStates.summary} ilike ${pattern} then 2
      else 3
    end
  `;
}

function kindRank(): SQL {
  return sql`
    case ${relationshipItems.kind}
      when 'preference' then 0
      when 'open_loop' then 1
      when 'key_fact' then 2
      else 3
    end
  `;
}

async function loadMemoryRows(
  db: ReadonlyDb,
  params: RecallParams | ContextParams,
): Promise<readonly MemoryRecallRow[]> {
  const filters = memoryFilters(params, {
    q: params.q,
    kind: "kind" in params ? params.kind : undefined,
  });
  const rankingOrder = params.q?.trim() ? [queryRank(params.q)] : [];

  return await db
    .select({
      id: relationshipItems.id,
      kind: relationshipItems.kind,
      text: relationshipItems.text,
      confidence: relationshipItems.confidence,
      lastSeenAt: relationshipItems.lastSeenAt,
      relationshipStateId: relationshipStates.id,
      relationshipType: relationshipStates.relationshipType,
      relationshipStatus: relationshipStates.status,
      relationshipSummary: relationshipStates.summary,
      lastInteractionAt: relationshipStates.lastInteractionAt,
      entityId: relationshipEntities.id,
      entityType: relationshipEntities.type,
      displayName: relationshipEntities.displayName,
      primaryEmail: relationshipEntities.primaryEmail,
      domain: relationshipEntities.domain,
    })
    .from(relationshipItems)
    .innerJoin(
      relationshipStates,
      eq(relationshipStates.id, relationshipItems.relationshipStateId),
    )
    .innerJoin(
      relationshipEntities,
      eq(relationshipEntities.id, relationshipStates.entityId),
    )
    .where(and(...filters))
    .orderBy(
      ...rankingOrder,
      kindRank(),
      desc(relationshipItems.confidence),
      desc(relationshipItems.lastSeenAt),
    )
    .limit(params.limit);
}

async function loadSourcesByItemId(
  db: ReadonlyDb,
  scope: MemoryScope,
  itemIds: readonly string[],
): Promise<ReadonlyMap<string, MemoryRecallItem["sources"]>> {
  if (itemIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: relationshipItemSources.id,
      relationshipItemId: relationshipItemSources.relationshipItemId,
      provider: relationshipItemSources.provider,
      externalId: relationshipItemSources.externalId,
      threadId: relationshipItemSources.threadId,
      messageId: relationshipItemSources.messageId,
      quote: relationshipItemSources.quote,
      occurredAt: relationshipItemSources.occurredAt,
    })
    .from(relationshipItemSources)
    .where(
      and(
        eq(relationshipItemSources.orgId, scope.orgId),
        eq(relationshipItemSources.userId, scope.userId),
        inArray(relationshipItemSources.relationshipItemId, [...itemIds]),
      ),
    )
    .orderBy(desc(relationshipItemSources.occurredAt));

  const sourcesByItemId = new Map<string, MemoryRecallItem["sources"]>();
  for (const row of rows) {
    const bucket = sourcesByItemId.get(row.relationshipItemId) ?? [];
    bucket.push({
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      threadId: row.threadId,
      messageId: row.messageId,
      quote: row.quote,
      occurredAt: serializeDate(row.occurredAt),
    });
    sourcesByItemId.set(row.relationshipItemId, bucket);
  }
  return sourcesByItemId;
}

async function hydrateMemories(
  db: ReadonlyDb,
  scope: MemoryScope,
  rows: readonly MemoryRecallRow[],
): Promise<readonly MemoryRecallItem[]> {
  const itemIds = rows.map((row) => {
    return row.id;
  });
  const sourcesByItemId = await loadSourcesByItemId(db, scope, itemIds);

  return rows.map((row) => {
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      confidence: row.confidence,
      lastSeenAt: row.lastSeenAt.toISOString(),
      relationship: {
        id: row.relationshipStateId,
        entity: {
          id: row.entityId,
          type: row.entityType,
          displayName: row.displayName,
          primaryEmail: row.primaryEmail,
          domain: row.domain,
        },
        relationshipType: row.relationshipType,
        status: row.relationshipStatus,
        summary: row.relationshipSummary,
        lastInteractionAt: serializeDate(row.lastInteractionAt),
      },
      sources: sourcesByItemId.get(row.id) ?? [],
    };
  });
}

export async function recallZeroMemory(
  db: ReadonlyDb,
  params: RecallParams,
): Promise<MemoryRecallResponse> {
  const rows = await loadMemoryRows(db, params);
  const memories = await hydrateMemories(db, params, rows);
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
  const rows = await loadMemoryRows(db, params);
  const memories = await hydrateMemories(db, params, rows);
  return {
    query: params.q ?? null,
    context: formatMemoryContext(memories),
    memories: [...memories],
  };
}
