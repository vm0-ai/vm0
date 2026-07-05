import { command } from "ccstate";
import {
  testRelationshipStateContract,
  type TestRelationshipStateActionBody,
} from "@vm0/api-contracts/contracts/test-relationship-state";
import {
  relationshipEntities,
  relationshipItems,
  relationshipStates,
} from "@vm0/db/schema/relationship-memory";
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

type RelationshipAction<
  TAction extends TestRelationshipStateActionBody["action"],
> = Extract<TestRelationshipStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function deleteRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"delete-relationships">,
  signal: AbortSignal,
) {
  await db
    .delete(relationshipEntities)
    .where(
      and(
        eq(relationshipEntities.orgId, body.fixture.org_id),
        eq(relationshipEntities.userId, body.fixture.user_id),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function seedRelationshipsForAction(
  db: Db,
  body: RelationshipAction<"seed-relationships">,
  signal: AbortSignal,
) {
  if (body.count === 0) {
    return actionOk();
  }

  const entities = await db
    .insert(relationshipEntities)
    .values(
      Array.from({ length: body.count }, (_, index) => {
        const entityType: "person" | "organization" =
          index % 2 === 0 ? "person" : "organization";
        return {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          type: entityType,
          identityKey: `${entityType}-${index}@relationship.test`,
          displayName: `Relationship ${String(index + 1).padStart(3, "0")}`,
          primaryEmail:
            entityType === "person"
              ? `person-${index}@relationship.test`
              : null,
          domain: `relationship-${index}.test`,
        };
      }),
    )
    .returning({ id: relationshipEntities.id });
  signal.throwIfAborted();

  const states = await db
    .insert(relationshipStates)
    .values(
      entities.map((entity, index) => {
        return {
          orgId: body.fixture.org_id,
          userId: body.fixture.user_id,
          entityId: entity.id,
          relationshipType:
            index % 2 === 0 ? "Customer contact" : "Organization",
          summary: `Relationship pagination fixture ${index + 1}`,
          lastInteractionAt: new Date(
            Date.parse("2026-07-05T12:00:00.000Z") - index * 60_000,
          ),
        };
      }),
    )
    .returning({ id: relationshipStates.id });
  signal.throwIfAborted();

  const openLoopItems = states
    .map((state, index) => {
      if (index % 10 !== 0) {
        return null;
      }
      return {
        orgId: body.fixture.org_id,
        userId: body.fixture.user_id,
        relationshipStateId: state.id,
        kind: "open_loop" as const,
        text: `Follow up with relationship ${index + 1}`,
        confidence: 90,
        lastSeenAt: new Date(
          Date.parse("2026-07-05T12:00:00.000Z") - index * 60_000,
        ),
      };
    })
    .filter((item): item is NonNullable<typeof item> => {
      return item !== null;
    });
  if (openLoopItems.length > 0) {
    await db.insert(relationshipItems).values(openLoopItems);
  }
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
    }
  },
);

export const testRelationshipStateRoutes: readonly RouteEntry[] = [
  {
    route: testRelationshipStateContract.action,
    handler: mutateRelationshipState$,
  },
];
