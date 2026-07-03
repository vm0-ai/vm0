import { randomUUID } from "node:crypto";

import { zeroRelationshipsContract } from "@vm0/api-contracts/contracts/zero-relationships";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface RelationshipFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function relationshipsClient() {
  return setupApp({ context })(zeroRelationshipsContract);
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
  if (enabled) {
    await updateFeatureSwitchesForUser(
      context,
      { orgId, userId },
      { [FeatureSwitchKey.RelationshipMemory]: true },
    );
  }
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

async function deleteRelationshipFixture(
  fixture: RelationshipFixture,
): Promise<void> {
  await deleteFeatureSwitchesForUser(context, fixture);
}

describe("GET /api/zero/relationships/*", () => {
  const track = createFixtureTracker(deleteRelationshipFixture);

  it("returns empty read responses in the current org-user scope", async () => {
    await track(seedRelationshipFixture());

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "security" },
      }),
      [200],
    );
    expect(search.body).toStrictEqual({ relationships: [] });

    const resolved = await accept(
      relationshipsClient().resolve({
        headers: authHeaders(),
        query: { email: "alice@acme.com" },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual({ relationship: null });
  });

  it("rejects reads when relationship memory is not enabled", async () => {
    const fixture = await track(seedRelationshipFixture(false));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "alice" },
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Relationship memory is not enabled for this organization.",
    );
  });
});
