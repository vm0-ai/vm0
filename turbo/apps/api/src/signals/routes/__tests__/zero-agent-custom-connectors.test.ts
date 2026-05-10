import { randomUUID } from "node:crypto";

import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";
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

describe("GET /api/zero/agents/:id/custom-connectors", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
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
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
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

  it("returns empty enabledIds for an agent with no enabled custom connectors", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = fixture.composeIds[0]!;

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledIds: [] });
  });

  it("returns 404 for a non-existent agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
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
        { composes: [{ displayName: "Other Agent" }] },
        context.signal,
      ),
    );
    const sharedId = otherFixture.composeIds[0]!;

    const myFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
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

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
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

describe("PUT /api/zero/agents/:id/custom-connectors", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });
  const trackConnector = createFixtureTracker<CustomConnectorFixture>(
    (fixture) => {
      return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
    },
  );

  async function getEnabledIds(
    orgId: string,
    userId: string,
    agentId: string,
  ): Promise<readonly string[]> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ customConnectorId: userCustomConnectors.customConnectorId })
      .from(userCustomConnectors)
      .where(
        and(
          eq(userCustomConnectors.orgId, orgId),
          eq(userCustomConnectors.userId, userId),
          eq(userCustomConnectors.agentId, agentId),
        ),
      );
    return rows.map((r) => {
      return r.customConnectorId;
    });
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        headers: {},
        body: { enabledIds: [] },
      }),
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
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 for a non-existent agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
    const response = await accept(
      client.update({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("sets enabled ids and round-trips via DB read-after-write", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    const c1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: fixture.orgId, userId: fixture.userId, slug: "round-a" },
        context.signal,
      ),
    );
    const c2 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: fixture.orgId, userId: fixture.userId, slug: "round-b" },
        context.signal,
      ),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);

    const response = await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [c1.connectorId, c2.connectorId] },
      }),
      [200],
    );

    expect(new Set(response.body.enabledIds)).toStrictEqual(
      new Set([c1.connectorId, c2.connectorId]),
    );

    const persisted = await getEnabledIds(
      fixture.orgId,
      fixture.userId,
      agentId,
    );
    expect(new Set(persisted)).toStrictEqual(
      new Set([c1.connectorId, c2.connectorId]),
    );
  });

  it("replaces the list atomically", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    const c1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: fixture.orgId, userId: fixture.userId, slug: "rep-1" },
        context.signal,
      ),
    );
    const c2 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: fixture.orgId, userId: fixture.userId, slug: "rep-2" },
        context.signal,
      ),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);

    await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [c1.connectorId] },
      }),
      [200],
    );

    await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [c2.connectorId] },
      }),
      [200],
    );

    const persisted = await getEnabledIds(
      fixture.orgId,
      fixture.userId,
      agentId,
    );
    expect(persisted).toStrictEqual([c2.connectorId]);
  });

  it("clears authorizations with empty array", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    const c1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: fixture.orgId, userId: fixture.userId, slug: "clr-1" },
        context.signal,
      ),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);

    await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [c1.connectorId] },
      }),
      [200],
    );

    await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [200],
    );

    const persisted = await getEnabledIds(
      fixture.orgId,
      fixture.userId,
      agentId,
    );
    expect(persisted).toStrictEqual([]);
  });

  it("returns 400 for a cross-org custom connector id", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    // Connector seeded in a different org (auto-random orgId).
    const otherConnector = await trackConnector(
      store.set(seedCustomConnectorOrg$, { slug: "other-org" }, context.signal),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);

    const response = await accept(
      client.update({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [otherConnector.connectorId] },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Unknown custom connector ids: ${otherConnector.connectorId}`,
        code: "VALIDATION_ERROR",
      },
    });

    const persisted = await getEnabledIds(
      fixture.orgId,
      fixture.userId,
      agentId,
    );
    expect(persisted).toStrictEqual([]);
  });
});
