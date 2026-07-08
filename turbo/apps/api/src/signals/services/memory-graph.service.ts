import {
  memories,
  memoryEdges,
  memoryEntities,
  memoryEntityAliases,
  memoryProfiles,
  memorySourceLinks,
  memorySources,
  type MemoryAliasType,
  type MemoryEdgeType,
} from "@vm0/db/schema/memory-substrate";
import type {
  RelationshipItemKind,
  RelationshipMemoryProvider,
} from "@vm0/db/schema/relationship-memory";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

interface GraphRelationshipTarget {
  readonly type: "person" | "organization";
  readonly identityKey: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
}

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface GraphAlias {
  readonly aliasType: MemoryAliasType;
  readonly aliasValue: string;
}

export interface GraphMemoryCandidate {
  readonly ref: string;
  readonly id: string;
  readonly kind: RelationshipItemKind;
  readonly text: string;
}

export interface GraphMemoryRelation {
  readonly memoryRef: string;
  readonly relation: MemoryEdgeType;
}

interface GraphMemorySource {
  readonly provider: RelationshipMemoryProvider;
  readonly externalId: string;
  readonly connectorId?: string | null;
  readonly threadId?: string | null;
  readonly messageId?: string | null;
  readonly direction?: "sent" | "received" | "mixed" | "unknown";
}

export interface GraphRelationshipState {
  readonly summary: string | null;
  readonly relationshipType: string | null;
  readonly status: "active" | "quiet" | "archived";
  readonly lastInteractionAt: Date | null;
}

const RELATIONSHIP_PROFILE_SECTIONS = {
  summary: "relationship_summary",
  relationshipType: "relationship_type",
  status: "relationship_status",
  lastInteractionAt: "relationship_last_interaction_at",
} as const;

function targetAliases(target: GraphRelationshipTarget): readonly GraphAlias[] {
  const aliases: GraphAlias[] = [
    {
      aliasType: "relationship_identity",
      aliasValue: target.identityKey,
    },
  ];
  if (target.primaryEmail) {
    aliases.push({ aliasType: "email", aliasValue: target.primaryEmail });
  }
  if (target.type === "organization" && target.domain) {
    aliases.push({ aliasType: "domain", aliasValue: target.domain });
  }
  const slackChannel = target.identityKey.match(
    /^organization:slack:([^:]+):(.+)$/u,
  );
  if (slackChannel) {
    aliases.push({
      aliasType: "slack_channel",
      aliasValue: `${slackChannel[1]}:${slackChannel[2]}`,
    });
  }
  return aliases;
}

async function findEntityIdByAlias(
  db: ReadonlyDb,
  scope: MemoryScope,
  alias: GraphAlias,
): Promise<string | null> {
  const [row] = await db
    .select({ entityId: memoryEntityAliases.entityId })
    .from(memoryEntityAliases)
    .where(
      and(
        eq(memoryEntityAliases.orgId, scope.orgId),
        eq(memoryEntityAliases.userId, scope.userId),
        eq(memoryEntityAliases.aliasType, alias.aliasType),
        eq(memoryEntityAliases.aliasValue, alias.aliasValue),
      ),
    )
    .limit(1);
  return row?.entityId ?? null;
}

async function insertEntityAliases(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly entityId: string;
  readonly aliases: readonly GraphAlias[];
  readonly now: Date;
}): Promise<void> {
  if (args.aliases.length === 0) {
    return;
  }

  await args.db
    .insert(memoryEntityAliases)
    .values(
      args.aliases.map((alias) => {
        return {
          orgId: args.scope.orgId,
          userId: args.scope.userId,
          entityId: args.entityId,
          provider: null,
          aliasType: alias.aliasType,
          aliasValue: alias.aliasValue,
          createdAt: args.now,
          updatedAt: args.now,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function upsertGraphRelationshipEntity(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly target: GraphRelationshipTarget;
}): Promise<string> {
  const aliases = targetAliases(args.target);
  const scope = { orgId: args.orgId, userId: args.userId };
  for (const alias of aliases) {
    const existingEntityId = await findEntityIdByAlias(args.db, scope, alias);
    if (!existingEntityId) {
      continue;
    }
    await args.db
      .update(memoryEntities)
      .set({
        type: args.target.type,
        displayName: args.target.displayName,
        updatedAt: nowDate(),
      })
      .where(eq(memoryEntities.id, existingEntityId));
    await insertEntityAliases({
      db: args.db,
      scope,
      entityId: existingEntityId,
      aliases,
      now: nowDate(),
    });
    return existingEntityId;
  }

  const currentTime = nowDate();
  const [entity] = await args.db
    .insert(memoryEntities)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.target.type,
      displayName: args.target.displayName,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .returning({ id: memoryEntities.id });
  if (!entity) {
    throw new Error("Failed to upsert graph memory entity");
  }

  await insertEntityAliases({
    db: args.db,
    scope,
    entityId: entity.id,
    aliases,
    now: currentTime,
  });
  return entity.id;
}

export async function loadGraphMemoryCandidates(
  db: ReadonlyDb,
  args: MemoryScope & {
    readonly entityId: string;
    readonly limit: number;
  },
): Promise<readonly GraphMemoryCandidate[]> {
  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      text: memories.text,
    })
    .from(memories)
    .where(
      and(
        eq(memories.orgId, args.orgId),
        eq(memories.userId, args.userId),
        eq(memories.entityId, args.entityId),
        eq(memories.status, "active"),
        sql`${memories.kind} in ('key_fact', 'preference', 'open_loop')`,
      ),
    )
    .orderBy(desc(memories.lastSeenAt))
    .limit(args.limit);

  return rows.map((row, index) => {
    return {
      ref: `M${index + 1}`,
      id: row.id,
      kind: row.kind as RelationshipItemKind,
      text: row.text,
    };
  });
}

async function findMemorySourceId(
  db: ReadonlyDb,
  scope: MemoryScope,
  source: GraphMemorySource,
): Promise<string | null> {
  const [row] = await db
    .select({ id: memorySources.id })
    .from(memorySources)
    .where(
      and(
        eq(memorySources.orgId, scope.orgId),
        eq(memorySources.userId, scope.userId),
        eq(memorySources.provider, source.provider),
        eq(memorySources.externalId, source.externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function linkMemorySource(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly memoryId: string;
  readonly source: GraphMemorySource;
}): Promise<void> {
  const sourceId = await findMemorySourceId(args.db, args.scope, args.source);
  if (!sourceId) {
    return;
  }

  await args.db
    .insert(memorySourceLinks)
    .values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      memoryId: args.memoryId,
      sourceId,
      createdAt: nowDate(),
    })
    .onConflictDoNothing();

  await args.db
    .update(memories)
    .set({
      sourceCount: sql`(
        select count(*)::int
        from ${memorySourceLinks}
        where ${memorySourceLinks.memoryId} = ${args.memoryId}
      )`,
      updatedAt: nowDate(),
    })
    .where(eq(memories.id, args.memoryId));
}

async function archiveResolvedCandidate(args: {
  readonly db: Db;
  readonly candidate: GraphMemoryCandidate;
}): Promise<void> {
  await args.db
    .update(memories)
    .set({
      status: "archived",
      updatedAt: nowDate(),
    })
    .where(eq(memories.id, args.candidate.id));
}

async function applyGraphRelations(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly memoryId: string;
  readonly relations: readonly GraphMemoryRelation[];
  readonly candidates: readonly GraphMemoryCandidate[];
}): Promise<void> {
  if (args.relations.length === 0 || args.candidates.length === 0) {
    return;
  }

  const candidateByRef = new Map(
    args.candidates.map((candidate) => {
      return [candidate.ref, candidate];
    }),
  );

  for (const relation of args.relations) {
    const candidate = candidateByRef.get(relation.memoryRef);
    if (!candidate || candidate.id === args.memoryId) {
      continue;
    }

    await args.db
      .insert(memoryEdges)
      .values({
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        fromMemoryId: args.memoryId,
        toMemoryId: candidate.id,
        edgeType: relation.relation,
        createdAt: nowDate(),
      })
      .onConflictDoNothing();

    if (relation.relation === "updates" || relation.relation === "resolves") {
      await archiveResolvedCandidate({
        db: args.db,
        candidate,
      });
    }
  }
}

export async function upsertGraphMemory(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly entityId: string;
  readonly kind: RelationshipItemKind;
  readonly text: string;
  readonly confidence: number;
  readonly source: GraphMemorySource;
  readonly occurredAt: Date;
  readonly relations: readonly GraphMemoryRelation[];
  readonly candidates: readonly GraphMemoryCandidate[];
}): Promise<string> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const currentTime = nowDate();
  const [existing] = await args.db
    .select({
      id: memories.id,
      lastSeenAt: memories.lastSeenAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.orgId, args.orgId),
        eq(memories.userId, args.userId),
        eq(memories.entityId, args.entityId),
        eq(memories.kind, args.kind),
        eq(memories.text, args.text),
        eq(memories.status, "active"),
      ),
    )
    .limit(1);

  const memoryId =
    existing?.id ??
    (
      await args.db
        .insert(memories)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          entityId: args.entityId,
          kind: args.kind,
          status: "active",
          text: args.text,
          confidence: args.confidence,
          sourceCount: 0,
          lastSeenAt: args.occurredAt,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning({ id: memories.id })
    )[0]?.id;

  if (!memoryId) {
    throw new Error("Failed to upsert graph memory");
  }

  if (existing) {
    await args.db
      .update(memories)
      .set({
        confidence: args.confidence,
        lastSeenAt:
          existing.lastSeenAt.getTime() >= args.occurredAt.getTime()
            ? existing.lastSeenAt
            : args.occurredAt,
        updatedAt: currentTime,
      })
      .where(eq(memories.id, memoryId));
  }

  await linkMemorySource({
    db: args.db,
    scope,
    memoryId,
    source: args.source,
  });
  await applyGraphRelations({
    db: args.db,
    scope,
    memoryId,
    relations: args.relations,
    candidates: args.candidates,
  });

  return memoryId;
}

function parseRelationshipStatus(
  value: string | null,
): GraphRelationshipState["status"] {
  return value === "quiet" || value === "archived" ? value : "active";
}

function parseProfileDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function loadGraphRelationshipState(
  db: ReadonlyDb,
  args: MemoryScope & { readonly entityId: string },
): Promise<GraphRelationshipState> {
  const rows = await db
    .select({
      section: memoryProfiles.section,
      content: memoryProfiles.content,
    })
    .from(memoryProfiles)
    .where(
      and(
        eq(memoryProfiles.orgId, args.orgId),
        eq(memoryProfiles.userId, args.userId),
        eq(memoryProfiles.entityId, args.entityId),
      ),
    );
  const profileBySection = new Map(
    rows.map((row) => {
      return [row.section, row.content];
    }),
  );

  return {
    summary:
      profileBySection.get(RELATIONSHIP_PROFILE_SECTIONS.summary) ?? null,
    relationshipType:
      profileBySection.get(RELATIONSHIP_PROFILE_SECTIONS.relationshipType) ??
      null,
    status: parseRelationshipStatus(
      profileBySection.get(RELATIONSHIP_PROFILE_SECTIONS.status) ?? null,
    ),
    lastInteractionAt: parseProfileDate(
      profileBySection.get(RELATIONSHIP_PROFILE_SECTIONS.lastInteractionAt) ??
        null,
    ),
  };
}

async function upsertGraphProfileSection(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly entityId: string;
  readonly section: string;
  readonly content: string;
  readonly now: Date;
}): Promise<void> {
  await args.db
    .insert(memoryProfiles)
    .values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      entityId: args.entityId,
      section: args.section,
      content: args.content,
      sourceMemoryCount: 0,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [memoryProfiles.entityId, memoryProfiles.section],
      set: {
        content: args.content,
        updatedAt: args.now,
      },
    });
}

export async function upsertGraphRelationshipState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly entityId: string;
  readonly summary: string | null;
  readonly relationshipType: string | null;
  readonly status: GraphRelationshipState["status"];
  readonly lastInteractionAt: Date;
}): Promise<void> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const currentTime = nowDate();
  if (args.summary !== null) {
    await upsertGraphProfileSection({
      db: args.db,
      scope,
      entityId: args.entityId,
      section: RELATIONSHIP_PROFILE_SECTIONS.summary,
      content: args.summary,
      now: currentTime,
    });
  }
  if (args.relationshipType !== null) {
    await upsertGraphProfileSection({
      db: args.db,
      scope,
      entityId: args.entityId,
      section: RELATIONSHIP_PROFILE_SECTIONS.relationshipType,
      content: args.relationshipType,
      now: currentTime,
    });
  }
  await upsertGraphProfileSection({
    db: args.db,
    scope,
    entityId: args.entityId,
    section: RELATIONSHIP_PROFILE_SECTIONS.status,
    content: args.status,
    now: currentTime,
  });
  await upsertGraphProfileSection({
    db: args.db,
    scope,
    entityId: args.entityId,
    section: RELATIONSHIP_PROFILE_SECTIONS.lastInteractionAt,
    content: args.lastInteractionAt.toISOString(),
    now: currentTime,
  });
}

export async function recordGraphInteraction(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly entityId: string;
  readonly source: GraphMemorySource;
  readonly snippet: string;
  readonly occurredAt: Date;
}): Promise<void> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const sourceId = await findMemorySourceId(args.db, scope, args.source);
  if (sourceId) {
    const [existing] = await args.db
      .select({ memoryId: memorySourceLinks.memoryId })
      .from(memorySourceLinks)
      .innerJoin(memories, eq(memories.id, memorySourceLinks.memoryId))
      .where(
        and(
          eq(memorySourceLinks.orgId, args.orgId),
          eq(memorySourceLinks.userId, args.userId),
          eq(memorySourceLinks.sourceId, sourceId),
          eq(memories.entityId, args.entityId),
          eq(memories.kind, "recent_context"),
        ),
      )
      .limit(1);
    if (existing) {
      await args.db
        .update(memories)
        .set({
          text: args.snippet,
          lastSeenAt: args.occurredAt,
          updatedAt: nowDate(),
        })
        .where(eq(memories.id, existing.memoryId));
      return;
    }
  }

  const currentTime = nowDate();
  const [memory] = await args.db
    .insert(memories)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      entityId: args.entityId,
      kind: "recent_context",
      status: "active",
      text: args.snippet,
      confidence: 80,
      sourceCount: sourceId ? 1 : 0,
      lastSeenAt: args.occurredAt,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .returning({ id: memories.id });
  if (!memory || !sourceId) {
    return;
  }

  await args.db
    .insert(memorySourceLinks)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      memoryId: memory.id,
      sourceId,
      createdAt: currentTime,
    })
    .onConflictDoNothing();
}
