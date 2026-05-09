import { randomUUID } from "node:crypto";

import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/agents/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the agent when found in the active org", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Test Agent",
              description: "Test description",
              sound: "friendly",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = fixture.composeIds[0]!;

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      agentId,
      ownerId: fixture.userId,
      displayName: "Test Agent",
      description: "Test description",
      sound: "friendly",
      avatarUrl: null,
      permissionPolicies: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });

  it("returns 404 for an unknown agent id", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org (no existence leak)", async () => {
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Org Agent" }] },
        context.signal,
      ),
    );
    const sharedId = otherFixture.composeIds[0]!;

    const myFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: sharedId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${sharedId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 403 for a sandbox token without agent:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });
});
