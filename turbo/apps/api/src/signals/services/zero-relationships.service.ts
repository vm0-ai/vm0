import { computed, type Computed } from "ccstate";
import {
  RELATIONSHIP_RECENT_INTERACTION_LIMIT,
  type RelationshipRecord,
  type RelationshipResolveResponse,
  type RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
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

import { db$, type ReadonlyDb } from "../external/db";

type RelationshipBaseRow = {
  readonly stateId: string;
  readonly entityId: string;
  readonly entityType: "person" | "organization";
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string | null;
  readonly status: "active" | "quiet" | "archived" | null;
  readonly summary: string | null;
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
  readonly page: number;
  readonly limit: number;
  readonly entityType?: "person" | "organization";
  readonly itemKind?: "key_fact" | "preference" | "open_loop";
}

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

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function emptySearch(q: string | undefined): boolean {
  return q === undefined || q.trim().length === 0;
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
): RelationshipBaseRow["status"] {
  return value === "active" || value === "quiet" || value === "archived"
    ? value
    : null;
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

function relationshipBaseFilters(scope: RelationshipScope): SQL[] {
  return [
    eq(memoryEntities.orgId, scope.orgId),
    eq(memoryEntities.userId, scope.userId),
    sql`${memoryEntities.type} in ('person', 'organization')`,
  ];
}

function rowToRelationshipBase(row: {
  readonly entityId: string;
  readonly entityType: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string | null;
  readonly relationshipStatus: string | null;
  readonly relationshipSummary: string | null;
  readonly relationshipLastInteractionAt: string | null;
}): RelationshipBaseRow | null {
  if (row.entityType !== "person" && row.entityType !== "organization") {
    return null;
  }
  return {
    stateId: row.entityId,
    entityId: row.entityId,
    entityType: row.entityType,
    displayName: row.displayName,
    primaryEmail: row.primaryEmail,
    domain: row.domain,
    relationshipType: row.relationshipType,
    status: relationshipStatus(row.relationshipStatus),
    summary: row.relationshipSummary,
    lastInteractionAt: parseProfileDate(row.relationshipLastInteractionAt),
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

  const rows = await db
    .select({
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
    .from(memoryEntities)
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
    .where(
      and(
        ...relationshipBaseFilters(scope),
        inArray(memoryEntities.id, [...stateIds]),
      ),
    );

  const rowsByStateId = new Map<string, RelationshipBaseRow>();
  for (const row of rows) {
    const base = rowToRelationshipBase(row);
    if (base && !rowsByStateId.has(base.stateId)) {
      rowsByStateId.set(base.stateId, base);
    }
  }
  return [...rowsByStateId.values()];
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
      id: memories.id,
      entityId: memories.entityId,
      kind: memories.kind,
      text: memories.text,
      confidence: memories.confidence,
      lastSeenAt: memories.lastSeenAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.orgId, scope.orgId),
        eq(memories.userId, scope.userId),
        inArray(memories.entityId, [...stateIds]),
        eq(memories.status, "active"),
        sql`${memories.kind} in ('key_fact', 'preference', 'open_loop')`,
      ),
    )
    .orderBy(memories.kind, desc(memories.lastSeenAt));

  const itemIds = itemRows.map((item) => {
    return item.id;
  });

  const sourceRows =
    itemIds.length === 0
      ? []
      : await db
          .select({
            id: memorySourceLinks.id,
            memoryId: memorySourceLinks.memoryId,
            provider: memorySources.provider,
            externalId: memorySources.externalId,
            metadata: memorySources.metadata,
            occurredAt: memorySources.occurredAt,
          })
          .from(memorySourceLinks)
          .innerJoin(
            memorySources,
            eq(memorySources.id, memorySourceLinks.sourceId),
          )
          .where(
            and(
              eq(memorySourceLinks.orgId, scope.orgId),
              eq(memorySourceLinks.userId, scope.userId),
              inArray(memorySourceLinks.memoryId, itemIds),
            ),
          )
          .orderBy(desc(memorySources.occurredAt));

  const sourcesByItemId = new Map<
    string,
    RelationshipRecord["items"][number]["sources"]
  >();
  for (const source of sourceRows) {
    const bucket = sourcesByItemId.get(source.memoryId) ?? [];
    bucket.push({
      id: source.id,
      provider: source.provider,
      externalId: source.externalId,
      threadId: sourceMetadataValue(source.metadata, "threadId"),
      messageId:
        sourceMetadataValue(source.metadata, "messageId") ??
        sourceMetadataValue(source.metadata, "messageTs"),
      quote: null,
      occurredAt: serializeDate(source.occurredAt),
    });
    sourcesByItemId.set(source.memoryId, bucket);
  }

  const itemsByStateId = new Map<string, RelationshipRecord["items"]>();
  for (const item of itemRows) {
    if (!item.entityId) {
      continue;
    }
    const bucket = itemsByStateId.get(item.entityId) ?? [];
    bucket.push({
      id: item.id,
      kind: item.kind as RelationshipRecord["items"][number]["kind"],
      text: item.text,
      confidence: item.confidence,
      lastSeenAt: item.lastSeenAt.toISOString(),
      sources: sourcesByItemId.get(item.id) ?? [],
    });
    itemsByStateId.set(item.entityId, bucket);
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
      id: memories.id,
      entityId: memories.entityId,
      snippet: memories.text,
      occurredAt: memories.lastSeenAt,
      provider: memorySources.provider,
      externalId: memorySources.externalId,
      metadata: memorySources.metadata,
      sourceOccurredAt: memorySources.occurredAt,
    })
    .from(memories)
    .innerJoin(memorySourceLinks, eq(memorySourceLinks.memoryId, memories.id))
    .innerJoin(memorySources, eq(memorySources.id, memorySourceLinks.sourceId))
    .where(
      and(
        eq(memories.orgId, scope.orgId),
        eq(memories.userId, scope.userId),
        inArray(memories.entityId, [...stateIds]),
        eq(memories.kind, "recent_context"),
        eq(memories.status, "active"),
      ),
    )
    .orderBy(memories.entityId, desc(memories.lastSeenAt));

  const seenMemoryIds = new Set<string>();
  const interactionsByStateId = new Map<
    string,
    RelationshipRecord["recentInteractions"]
  >();
  for (const row of rows) {
    if (!row.entityId || seenMemoryIds.has(row.id)) {
      continue;
    }
    seenMemoryIds.add(row.id);
    const bucket = interactionsByStateId.get(row.entityId) ?? [];
    if (bucket.length >= RELATIONSHIP_RECENT_INTERACTION_LIMIT) {
      continue;
    }
    bucket.push({
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      threadId: sourceMetadataValue(row.metadata, "threadId"),
      messageId:
        sourceMetadataValue(row.metadata, "messageId") ??
        sourceMetadataValue(row.metadata, "messageTs"),
      subject: null,
      snippet: row.snippet,
      occurredAt: (row.sourceOccurredAt ?? row.occurredAt).toISOString(),
    });
    interactionsByStateId.set(row.entityId, bucket);
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
  const filters = relationshipBaseFilters(params);

  if (params.id) {
    filters.push(eq(memoryEntities.id, params.id));
  } else if (params.email) {
    filters.push(ilike(emailAliases.aliasValue, params.email));
  } else if (params.domain) {
    filters.push(
      ilike(domainAliases.aliasValue, normalizeLookup(params.domain)),
    );
  }

  const orderBy = params.domain
    ? [
        sql`case when ${memoryEntities.type} = 'organization' then 0 else 1 end`,
        desc(relationshipLastInteractionProfiles.content),
      ]
    : [desc(relationshipLastInteractionProfiles.content)];

  const [row] = await db
    .select({
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
    .from(memoryEntities)
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
    .orderBy(...orderBy)
    .limit(1);

  return row ? rowToRelationshipBase(row) : null;
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

function relationshipSearchFilters(params: RelationshipSearchParams): SQL[] {
  const query = params.q?.trim() ?? "";
  const filters = relationshipBaseFilters(params);

  if (params.entityType) {
    filters.push(eq(memoryEntities.type, params.entityType));
  }
  if (params.itemKind) {
    filters.push(eq(memories.kind, params.itemKind));
  }
  if (!emptySearch(params.q)) {
    const pattern = `%${query}%`;
    const searchFilter = or(
      ilike(memoryEntities.displayName, pattern),
      ilike(emailAliases.aliasValue, pattern),
      ilike(domainAliases.aliasValue, pattern),
      ilike(relationshipTypeProfiles.content, pattern),
      ilike(relationshipSummaryProfiles.content, pattern),
      ilike(memories.text, pattern),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return filters;
}

async function countSearchRelationships(
  db: ReadonlyDb,
  params: RelationshipSearchParams,
): Promise<number> {
  const filters = relationshipSearchFilters(params);
  const [row] = await db
    .select({
      total: sql<number>`count(distinct ${memoryEntities.id})::int`,
    })
    .from(memoryEntities)
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
      relationshipSummaryProfiles,
      and(
        eq(relationshipSummaryProfiles.entityId, memoryEntities.id),
        eq(relationshipSummaryProfiles.section, "relationship_summary"),
      ),
    )
    .leftJoin(
      memories,
      and(
        eq(memories.entityId, memoryEntities.id),
        eq(memories.status, "active"),
        sql`${memories.kind} in ('key_fact', 'preference', 'open_loop')`,
      ),
    )
    .where(and(...filters));

  return Number(row?.total ?? 0);
}

async function loadSearchStateIds(
  db: ReadonlyDb,
  params: RelationshipSearchParams,
): Promise<readonly string[]> {
  const filters = relationshipSearchFilters(params);
  const offset = (params.page - 1) * params.limit;

  const rows = await db
    .select({
      stateId: memoryEntities.id,
    })
    .from(memoryEntities)
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
    .leftJoin(
      memories,
      and(
        eq(memories.entityId, memoryEntities.id),
        eq(memories.status, "active"),
        sql`${memories.kind} in ('key_fact', 'preference', 'open_loop')`,
      ),
    )
    .where(and(...filters))
    .groupBy(
      memoryEntities.id,
      relationshipStatusProfiles.content,
      relationshipLastInteractionProfiles.content,
    )
    .orderBy(
      sql`case when ${relationshipStatusProfiles.content} = 'active' or ${relationshipStatusProfiles.content} is null then 0 else 1 end`,
      desc(relationshipLastInteractionProfiles.content),
    )
    .limit(params.limit)
    .offset(offset);

  return rows.map((row) => {
    return row.stateId;
  });
}

async function searchRelationshipMemory(
  db: ReadonlyDb,
  params: RelationshipSearchParams,
): Promise<RelationshipSearchResponse> {
  const [total, stateIds] = await Promise.all([
    countSearchRelationships(db, params),
    loadSearchStateIds(db, params),
  ]);
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
  const totalPages = Math.max(1, Math.ceil(total / params.limit));
  return {
    relationships,
    pagination: {
      page: params.page,
      pageSize: params.limit,
      total,
      totalPages,
      hasMore: params.page < totalPages,
    },
  };
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
