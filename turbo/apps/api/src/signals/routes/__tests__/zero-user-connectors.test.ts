import { randomUUID } from "node:crypto";

import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteSkillsForFixture$,
  seedAgentForInstructions$,
  seedSkillsFixture$,
  seedUserConnector$,
  type SkillsFixture,
} from "./helpers/zero-skills";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUserConnectorsContract);
}

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      apiClient().get({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 for a non-existent agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const fakeId = randomUUID();
    const response = await accept(
      apiClient().get({
        params: { id: fakeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when agent belongs to a different org", async () => {
    const ownerFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );

    const callerFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(callerFixture.userId, callerFixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });

  it("returns empty enabledTypes for a new agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ enabledTypes: [] });
  });

  it("ignores connector grants for removed connector types", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "nano-banana",
      },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledTypes: ["github"] });
  });
});
