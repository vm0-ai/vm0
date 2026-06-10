import { randomUUID } from "node:crypto";

import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore } from "ccstate";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { seedUserConnector$ } from "./helpers/zero-skills";
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

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentsByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

interface ZeroAgentRouteFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

async function createAgentThroughApi(): Promise<ZeroAgentRouteFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  context.mocks.s3.send.mockResolvedValue({});

  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: { displayName: "Connector Test Agent" },
    }),
    [201],
  );

  return { orgId, userId, agentId: response.body.agentId };
}

async function deleteAgentThroughApi(
  fixture: ZeroAgentRouteFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    agentsByIdClient().delete({
      params: { id: fixture.agentId },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

async function cliAuthHeaders(fixture: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<{ readonly authorization: string }> {
  const tokenId = randomUUID();
  const token = generateCliToken(fixture.userId, fixture.orgId, tokenId);
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: fixture.userId,
    name: "test token",
    expiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await writeDb
    .insert(orgMembersCache)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
      cachedAt: new Date(now()),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: "admin", cachedAt: new Date(now()) },
    });

  return { authorization: `Bearer ${token}` };
}

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const trackAgent = createFixtureTracker<ZeroAgentRouteFixture>((fixture) => {
    return deleteAgentThroughApi(fixture);
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
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

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
    const ownerFixture = await trackAgent(createAgentThroughApi());
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        params: { id: ownerFixture.agentId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${ownerFixture.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns empty enabledTypes for a new agent", async () => {
    const fixture = await trackAgent(createAgentThroughApi());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ enabledTypes: [] });
  });

  it("accepts a CLI token for the agent owner", async () => {
    const fixture = await trackAgent(createAgentThroughApi());

    const response = await accept(
      apiClient().get({
        params: { id: fixture.agentId },
        headers: await cliAuthHeaders(fixture),
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ enabledTypes: [] });
  });

  it("ignores connector grants for removed connector types", async () => {
    const fixture = await trackAgent(createAgentThroughApi());
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        connectorType: "nano-banana",
      },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledTypes: ["github"] });
  });

  it("ignores connector grants for feature-flag-disabled types", async () => {
    const fixture = await trackAgent(createAgentThroughApi());
    // `spotify` is a valid connector type but gated behind a feature switch
    // that is off by default, so it must not be returned to the client. If it
    // were, the client would replay it on the next update and the update
    // endpoint would reject the whole request as unavailable.
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        connectorType: "spotify",
      },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledTypes: ["github"] });
  });
});
