import { computed, type Computed } from "ccstate";
import {
  RELATIONSHIP_RECENT_INTERACTION_LIMIT,
  type RelationshipRecord,
  type RelationshipResolveResponse,
  type RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
import {
  relationshipEntities,
  relationshipInteractions,
  relationshipItems,
  relationshipItemSources,
  relationshipStates,
} from "@vm0/db/schema/relationship-memory";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";

type RelationshipBaseRow = {
  readonly stateId: string;
  readonly entityId: string;
  readonly entityType: "person" | "organization";
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string;
  readonly status: "active" | "quiet" | "archived";
  readonly summary: string;
  readonly lastInteractionAt: Date | null;
};

interface RelationshipScope {
  readonly orgId: string;
  readonly userId: string;
}

interface RelationshipResolveParams extends RelationshipScope {
  readonly id?: string;
  readonly email?: string;
  readonly domain?: string;
}

interface RelationshipSearchParams extends RelationshipScope {
  readonly q?: string;
  readonly limit: number;
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function emptySearch(q: string | undefined): boolean {
  return q === undefined || q.trim().length === 0;
}

function exactMatchScore(row: RelationshipBaseRow, query: string): number {
  if (!query) {
    return 0;
  }
  const normalizedQuery = normalizeLookup(query);
  if (row.primaryEmail?.toLowerCase() === normalizedQuery) {
    return 4;
  }
  if (row.domain?.toLowerCase() === normalizedQuery) {
    return 3;
  }
  if (row.displayName.toLowerCase() === normalizedQuery) {
    return 2;
  }
  return row.displayName.toLowerCase().includes(normalizedQuery) ? 1 : 0;
}

function compareRelationshipRows(q: string | undefined) {
  const query = q?.trim() ?? "";
  return (a: RelationshipBaseRow, b: RelationshipBaseRow): number => {
    const scoreDiff = exactMatchScore(b, query) - exactMatchScore(a, query);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    const activeDiff =
      Number(b.status === "active") - Number(a.status === "active");
    if (activeDiff !== 0) {
      return activeDiff;
    }

    const aTime = a.lastInteractionAt?.getTime() ?? 0;
    const bTime = b.lastInteractionAt?.getTime() ?? 0;
    return bTime - aTime;
  };
}

async function loadRelationshipRowsByStateIds(
  db: ReadonlyDb,
  scope: RelationshipScope,
  stateIds: readonly string[],
): Promise<readonly RelationshipBaseRow[]> {
  if (stateIds.length === 0) {
    return [];
  }

  return await db
    .select({
      stateId: relationshipStates.id,
      entityId: relationshipEntities.id,
      entityType: relationshipEntities.type,
      displayName: relationshipEntities.displayName,
      primaryEmail: relationshipEntities.primaryEmail,
      domain: relationshipEntities.domain,
      relationshipType: relationshipStates.relationshipType,
      status: relationshipStates.status,
      summary: relationshipStates.summary,
      lastInteractionAt: relationshipStates.lastInteractionAt,
    })
    .from(relationshipStates)
    .innerJoin(
      relationshipEntities,
      eq(relationshipEntities.id, relationshipStates.entityId),
    )
    .where(
      and(
        eq(relationshipStates.orgId, scope.orgId),
        eq(relationshipStates.userId, scope.userId),
        inArray(relationshipStates.id, [...stateIds]),
      ),
    );
}

async function loadRelationshipItemsByStateId(
  db: ReadonlyDb,
  scope: RelationshipScope,
  stateIds: readonly string[],
) {
  if (stateIds.length === 0) {
    return new Map<string, RelationshipRecord["items"]>();
  }

  const itemRows = await db
    .select({
      id: relationshipItems.id,
      relationshipStateId: relationshipItems.relationshipStateId,
      kind: relationshipItems.kind,
      text: relationshipItems.text,
      confidence: relationshipItems.confidence,
      lastSeenAt: relationshipItems.lastSeenAt,
    })
    .from(relationshipItems)
    .where(
      and(
        eq(relationshipItems.orgId, scope.orgId),
        eq(relationshipItems.userId, scope.userId),
        inArray(relationshipItems.relationshipStateId, [...stateIds]),
        isNull(relationshipItems.archivedAt),
      ),
    )
    .orderBy(relationshipItems.kind, desc(relationshipItems.lastSeenAt));

  const itemIds = itemRows.map((item) => {
    return item.id;
  });

  const sourceRows =
    itemIds.length === 0
      ? []
      : await db
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
              inArray(relationshipItemSources.relationshipItemId, itemIds),
            ),
          )
          .orderBy(desc(relationshipItemSources.occurredAt));

  const sourcesByItemId = new Map<
    string,
    RelationshipRecord["items"][number]["sources"]
  >();
  for (const source of sourceRows) {
    const bucket = sourcesByItemId.get(source.relationshipItemId) ?? [];
    bucket.push({
      id: source.id,
      provider: source.provider,
      externalId: source.externalId,
      threadId: source.threadId,
      messageId: source.messageId,
      quote: source.quote,
      occurredAt: serializeDate(source.occurredAt),
    });
    sourcesByItemId.set(source.relationshipItemId, bucket);
  }

  const itemsByStateId = new Map<string, RelationshipRecord["items"]>();
  for (const item of itemRows) {
    const bucket = itemsByStateId.get(item.relationshipStateId) ?? [];
    bucket.push({
      id: item.id,
      kind: item.kind,
      text: item.text,
      confidence: item.confidence,
      lastSeenAt: item.lastSeenAt.toISOString(),
      sources: sourcesByItemId.get(item.id) ?? [],
    });
    itemsByStateId.set(item.relationshipStateId, bucket);
  }

  return itemsByStateId;
}

async function loadRecentInteractionsByStateId(
  db: ReadonlyDb,
  scope: RelationshipScope,
  stateIds: readonly string[],
) {
  if (stateIds.length === 0) {
    return new Map<string, RelationshipRecord["recentInteractions"]>();
  }

  const rows = await db
    .select({
      id: relationshipInteractions.id,
      relationshipStateId: relationshipInteractions.relationshipStateId,
      provider: relationshipInteractions.provider,
      externalId: relationshipInteractions.externalId,
      threadId: relationshipInteractions.threadId,
      messageId: relationshipInteractions.messageId,
      subject: relationshipInteractions.subject,
      snippet: relationshipInteractions.snippet,
      occurredAt: relationshipInteractions.occurredAt,
    })
    .from(relationshipInteractions)
    .where(
      and(
        eq(relationshipInteractions.orgId, scope.orgId),
        eq(relationshipInteractions.userId, scope.userId),
        inArray(relationshipInteractions.relationshipStateId, [...stateIds]),
      ),
    )
    .orderBy(
      relationshipInteractions.relationshipStateId,
      desc(relationshipInteractions.occurredAt),
    );

  const interactionsByStateId = new Map<
    string,
    RelationshipRecord["recentInteractions"]
  >();
  for (const row of rows) {
    const bucket = interactionsByStateId.get(row.relationshipStateId) ?? [];
    if (bucket.length >= RELATIONSHIP_RECENT_INTERACTION_LIMIT) {
      continue;
    }
    bucket.push({
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      threadId: row.threadId,
      messageId: row.messageId,
      subject: row.subject,
      snippet: row.snippet,
      occurredAt: row.occurredAt.toISOString(),
    });
    interactionsByStateId.set(row.relationshipStateId, bucket);
  }
  return interactionsByStateId;
}

async function hydrateRelationshipRows(
  db: ReadonlyDb,
  scope: RelationshipScope,
  rows: readonly RelationshipBaseRow[],
): Promise<RelationshipRecord[]> {
  const stateIds = rows.map((row) => {
    return row.stateId;
  });
  const [itemsByStateId, interactionsByStateId] = await Promise.all([
    loadRelationshipItemsByStateId(db, scope, stateIds),
    loadRecentInteractionsByStateId(db, scope, stateIds),
  ]);

  return rows.map((row) => {
    return {
      id: row.stateId,
      entity: {
        id: row.entityId,
        type: row.entityType,
        displayName: row.displayName,
        primaryEmail: row.primaryEmail,
        domain: row.domain,
      },
      relationshipType: row.relationshipType,
      status: row.status,
      summary: row.summary,
      lastInteractionAt: serializeDate(row.lastInteractionAt),
      items: itemsByStateId.get(row.stateId) ?? [],
      recentInteractions: interactionsByStateId.get(row.stateId) ?? [],
    };
  });
}

async function loadResolvedRelationshipRow(
  db: ReadonlyDb,
  params: RelationshipResolveParams,
): Promise<RelationshipBaseRow | null> {
  const filters = [
    eq(relationshipStates.orgId, params.orgId),
    eq(relationshipStates.userId, params.userId),
  ];

  if (params.id) {
    filters.push(eq(relationshipStates.id, params.id));
  } else if (params.email) {
    filters.push(ilike(relationshipEntities.primaryEmail, params.email));
  } else if (params.domain) {
    filters.push(
      ilike(relationshipEntities.domain, normalizeLookup(params.domain)),
    );
  }

  const orderBy = params.domain
    ? [
        sql`case when ${relationshipEntities.type} = 'organization' then 0 else 1 end`,
        desc(relationshipStates.lastInteractionAt),
      ]
    : [desc(relationshipStates.lastInteractionAt)];

  const [row] = await db
    .select({
      stateId: relationshipStates.id,
      entityId: relationshipEntities.id,
      entityType: relationshipEntities.type,
      displayName: relationshipEntities.displayName,
      primaryEmail: relationshipEntities.primaryEmail,
      domain: relationshipEntities.domain,
      relationshipType: relationshipStates.relationshipType,
      status: relationshipStates.status,
      summary: relationshipStates.summary,
      lastInteractionAt: relationshipStates.lastInteractionAt,
    })
    .from(relationshipStates)
    .innerJoin(
      relationshipEntities,
      eq(relationshipEntities.id, relationshipStates.entityId),
    )
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(1);

  return row ?? null;
}

async function resolveRelationshipMemory(
  db: ReadonlyDb,
  params: RelationshipResolveParams,
): Promise<RelationshipResolveResponse> {
  const row = await loadResolvedRelationshipRow(db, params);
  if (!row) {
    return { relationship: null };
  }
  const [relationship] = await hydrateRelationshipRows(db, params, [row]);
  return { relationship: relationship ?? null };
}

async function loadSearchStateIds(
  db: ReadonlyDb,
  params: RelationshipSearchParams,
): Promise<readonly string[]> {
  const query = params.q?.trim() ?? "";
  const filters = [
    eq(relationshipStates.orgId, params.orgId),
    eq(relationshipStates.userId, params.userId),
  ];

  if (!emptySearch(params.q)) {
    const pattern = `%${query}%`;
    const searchFilter = or(
      ilike(relationshipEntities.displayName, pattern),
      ilike(relationshipEntities.primaryEmail, pattern),
      ilike(relationshipEntities.domain, pattern),
      ilike(relationshipStates.relationshipType, pattern),
      ilike(relationshipStates.summary, pattern),
      ilike(relationshipItems.text, pattern),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  const rows = await db
    .select({
      stateId: relationshipStates.id,
      rankTime: relationshipStates.lastInteractionAt,
    })
    .from(relationshipStates)
    .innerJoin(
      relationshipEntities,
      eq(relationshipEntities.id, relationshipStates.entityId),
    )
    .leftJoin(
      relationshipItems,
      and(
        eq(relationshipItems.relationshipStateId, relationshipStates.id),
        isNull(relationshipItems.archivedAt),
      ),
    )
    .where(and(...filters))
    .orderBy(
      sql`case when ${relationshipStates.status} = 'active' then 0 else 1 end`,
      desc(relationshipStates.lastInteractionAt),
    )
    .limit(params.limit * 5);

  const stateIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.stateId)) {
      continue;
    }
    seen.add(row.stateId);
    stateIds.push(row.stateId);
    if (stateIds.length >= params.limit) {
      break;
    }
  }
  return stateIds;
}

async function searchRelationshipMemory(
  db: ReadonlyDb,
  params: RelationshipSearchParams,
): Promise<RelationshipSearchResponse> {
  const stateIds = await loadSearchStateIds(db, params);
  const rows = await loadRelationshipRowsByStateIds(db, params, stateIds);
  const rowById = new Map(
    rows.map((row) => {
      return [row.stateId, row];
    }),
  );
  const orderedRows = stateIds
    .map((stateId) => {
      return rowById.get(stateId) ?? null;
    })
    .filter((row): row is RelationshipBaseRow => {
      return row !== null;
    })
    .sort(compareRelationshipRows(params.q));
  const relationships = await hydrateRelationshipRows(db, params, orderedRows);
  return { relationships };
}

export function zeroRelationshipResolve(
  params: RelationshipResolveParams,
): Computed<Promise<RelationshipResolveResponse>> {
  return computed(async (get): Promise<RelationshipResolveResponse> => {
    return await resolveRelationshipMemory(get(db$), params);
  });
}

export function zeroRelationshipSearch(
  params: RelationshipSearchParams,
): Computed<Promise<RelationshipSearchResponse>> {
  return computed(async (get): Promise<RelationshipSearchResponse> => {
    return await searchRelationshipMemory(get(db$), params);
  });
}
