import { command } from "ccstate";
import {
  testRelationshipStateContract,
  type TestRelationshipStateActionBody,
} from "@vm0/api-contracts/contracts/test-relationship-state";
import {
  memories,
  memoryEntities,
  memoryEntityAliases,
  memoryProfiles,
  memorySources,
} from "@vm0/db/schema/memory-substrate";
import { and, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testRelationshipStateContract.action);
const FIXTURE_START_TIME = Date.parse("2026-07-05T12:00:00.000Z");

type RelationshipAction<
  TAction extends TestRelationshipStateActionBody["action"],
> = Extract<TestRelationshipStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

function scopedWhere(body: RelationshipAction<"delete-relationships">) {
  return {
    orgId: body.fixture.org_id,
    userId: body.fixture.user_id,
  };
}

async function deleteRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"delete-relationships">,
  signal: AbortSignal,
) {
  const scope = scopedWhere(body);
  await db
    .delete(memories)
    .where(
      and(eq(memories.orgId, scope.orgId), eq(memories.userId, scope.userId)),
    );
  await db
    .delete(memorySources)
    .where(
      and(
        eq(memorySources.orgId, scope.orgId),
        eq(memorySources.userId, scope.userId),
      ),
    );
  await db
    .delete(memoryEntities)
    .where(
      and(
        eq(memoryEntities.orgId, scope.orgId),
        eq(memoryEntities.userId, scope.userId),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

function relationshipEntityValues(
  body: RelationshipAction<"seed-relationships">,
) {
  return Array.from({ length: body.count }, (_, index) => {
    const entityType: "person" | "organization" =
      index % 2 === 0 ? "person" : "organization";
    return {
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      type: entityType,
      identityKey: `${entityType}-${index}@relationship.test`,
      displayName: `Relationship ${String(index + 1).padStart(3, "0")}`,
      primaryEmail:
        entityType === "person" ? `person-${index}@relationship.test` : null,
      domain: `relationship-${index}.test`,
    };
  });
}

async function insertRelationshipEntityFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
) {
  const values = relationshipEntityValues(body);
  const entities = await db
    .insert(memoryEntities)
    .values(
      values.map((entity) => {
        return {
          orgId: entity.orgId,
          userId: entity.userId,
          type: entity.type,
          displayName: entity.displayName,
        };
      }),
    )
    .returning({
      id: memoryEntities.id,
      type: memoryEntities.type,
      displayName: memoryEntities.displayName,
    });
  return entities.map((entity, index) => {
    const value = values[index];
    if (!value) {
      throw new Error("Expected relationship fixture entity value");
    }
    return {
      ...entity,
      identityKey: value.identityKey,
      primaryEmail: value.primaryEmail,
      domain: value.domain,
    };
  });
}

type RelationshipEntityFixture = Awaited<
  ReturnType<typeof insertRelationshipEntityFixtures>
>[number];

async function insertGraphEntityAliases(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  await db.insert(memoryEntityAliases).values(
    entities.flatMap((entity) => {
      return [
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          provider: null,
          aliasType: "relationship_identity" as const,
          aliasValue: entity.identityKey,
        },
        ...(entity.primaryEmail
          ? [
              {
                orgId: body.fixture.org_id,
                userId: body.fixture.user_id,
                entityId: entity.id,
                provider: null,
                aliasType: "email" as const,
                aliasValue: entity.primaryEmail,
              },
            ]
          : []),
        ...(entity.type === "organization" && entity.domain
          ? [
              {
                orgId: body.fixture.org_id,
                userId: body.fixture.user_id,
                entityId: entity.id,
                provider: null,
                aliasType: "domain" as const,
                aliasValue: entity.domain,
              },
            ]
          : []),
      ];
    }),
  );
}

async function insertRelationshipProfileFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  await db.insert(memoryProfiles).values(
    entities.flatMap((entity, index) => {
      const lastInteractionAt = new Date(
        FIXTURE_START_TIME - index * 60_000,
      ).toISOString();
      return [
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_type",
          content: index % 2 === 0 ? "Customer contact" : "Organization",
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_status",
          content: "active",
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_summary",
          content: `Relationship pagination fixture ${index + 1}`,
        },
        {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          section: "relationship_last_interaction_at",
          content: lastInteractionAt,
        },
      ];
    }),
  );
}

function openLoopFixtureItems(
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  return entities
    .map((entity, index) => {
      if (index % 10 !== 0) {
        return null;
      }
      return {
        orgId: body.fixture.org_id,
        userId: body.fixture.user_id,
        entityId: entity.id,
        kind: "open_loop" as const,
        text: `Follow up with relationship ${index + 1}`,
        confidence: 90,
        lastSeenAt: new Date(FIXTURE_START_TIME - index * 60_000),
      };
    })
    .filter((item): item is NonNullable<typeof item> => {
      return item !== null;
    });
}

async function insertOpenLoopFixtures(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  entities: readonly RelationshipEntityFixture[],
) {
  const openLoopItems = openLoopFixtureItems(body, entities);
  if (openLoopItems.length > 0) {
    await db.insert(memories).values(
      openLoopItems.map((item) => {
        return {
          orgId: item.orgId,
          userId: item.userId,
          entityId: item.entityId,
          kind: item.kind,
          status: "active" as const,
          text: item.text,
          confidence: item.confidence,
          sourceCount: 0,
          lastSeenAt: item.lastSeenAt,
        };
      }),
    );
  }
}

async function seedRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  signal: AbortSignal,
) {
  if (body.count === 0) {
    return actionOk();
  }

  const entities = await insertRelationshipEntityFixtures(db, body);
  signal.throwIfAborted();
  await insertGraphEntityAliases(db, body, entities);
  signal.throwIfAborted();
  await insertRelationshipProfileFixtures(db, body, entities);
  signal.throwIfAborted();
  await insertOpenLoopFixtures(db, body, entities);
  signal.throwIfAborted();
  return actionOk();
}

async function seedRuntimeInjectionMemoriesForAction(
  db: Db,
  body: RelationshipAction<"seed-runtime-injection-memories">,
  signal: AbortSignal,
) {
  const [entity] = await db
    .insert(memoryEntities)
    .values({
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      type: "person",
      displayName: "Alice Runtime",
    })
    .returning({ id: memoryEntities.id });
  signal.throwIfAborted();
  if (!entity) {
    throw new Error("Expected runtime injection fixture entity");
  }

  await db.insert(memories).values([
    {
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      entityId: entity.id,
      kind: "preference",
      status: "active",
      text: "The user prefers concise launch summaries.",
      confidence: 92,
      lastSeenAt: new Date("2026-07-05T12:00:00.000Z"),
    },
    {
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      entityId: entity.id,
      kind: "recent_context",
      status: "active",
      text: "The current work is validating runtime memory injection.",
      confidence: 84,
      lastSeenAt: new Date("2026-07-06T12:00:00.000Z"),
    },
    {
      orgId: body.fixture.org_id,
      userId: body.fixture.user_id,
      entityId: entity.id,
      kind: "open_loop",
      status: "active",
      text: "Follow up on the security review injection preview.",
      confidence: 88,
      lastSeenAt: new Date("2026-07-07T12:00:00.000Z"),
    },
  ]);
  signal.throwIfAborted();
  return actionOk();
}

const mutateRelationshipState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "delete-relationships": {
        return await deleteRelationshipsForAction(db, body, signal);
      }
      case "seed-relationships": {
        return await seedRelationshipsForAction(db, body, signal);
      }
      case "seed-runtime-injection-memories": {
        return await seedRuntimeInjectionMemoriesForAction(db, body, signal);
      }
    }
  },
);

export const testRelationshipStateRoutes: readonly RouteEntry[] = [
  {
    route: testRelationshipStateContract.action,
    handler: mutateRelationshipState$,
  },
];
