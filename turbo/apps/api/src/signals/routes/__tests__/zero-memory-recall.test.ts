import { randomUUID } from "node:crypto";

import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteRelationshipRowsForFixture$,
  seedRelationshipRows$,
  type RelationshipFixture,
} from "./helpers/zero-relationships";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

async function seedRelationshipFixture(
  enabled = true,
): Promise<RelationshipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.RelationshipMemory]: enabled },
  );
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

async function deleteRelationshipFixture(
  fixture: RelationshipFixture,
): Promise<void> {
  await store.set(deleteRelationshipRowsForFixture$, fixture, context.signal);
  await deleteFeatureSwitchesForUser(context, fixture);
}

describe("GET /api/zero/memory/recall", () => {
  const track = createFixtureTracker(deleteRelationshipFixture);

  it("rejects recall when relationship memory is disabled", async () => {
    await track(seedRelationshipFixture(false));

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "relationship" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Relationship memory is not enabled for this organization.",
    );
  });

  it("recalls matching structured relationship memory", async () => {
    const fixture = await track(seedRelationshipFixture());
    await store.set(
      seedRelationshipRows$,
      { fixture, count: 3 },
      context.signal,
    );

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "relationship 1", limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBe("relationship 1");
    expect(response.body.memories).toHaveLength(1);
    expect(response.body.memories[0]).toMatchObject({
      kind: "open_loop",
      text: "Follow up with relationship 1",
      confidence: 90,
      relationship: {
        entity: {
          displayName: "Relationship 001",
          type: "person",
        },
        relationshipType: "Customer contact",
      },
      sources: [],
    });
  });

  it("returns prompt-ready memory context", async () => {
    const fixture = await track(seedRelationshipFixture());
    await store.set(
      seedRelationshipRows$,
      { fixture, count: 1 },
      context.signal,
    );

    const response = await accept(
      memoryClient().context({
        headers: authHeaders(),
        query: { limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBeNull();
    expect(response.body.context).toContain("Structured memory:");
    expect(response.body.context).toContain("Open loops:");
    expect(response.body.context).toContain(
      "Follow up with relationship 1 (Relationship 001)",
    );
    expect(response.body.memories).toHaveLength(1);
  });
});
