import { randomUUID } from "node:crypto";

import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken, signSandboxJwtForTests } from "../../auth/tokens";
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

// BDD migration of the legacy
// `zero-agent-custom-connectors.test.ts`. The 14 legacy
// `it()`s collapse into 3 BDD `it()`s:
// (1) GET chain (401 unauth → 401 no org → 200 empty
// enabledIds for a fresh agent → 200 accepts CLI token
// → 404 non-existent agent → 404 cross-org agent + no
// existence leak),
// (2) PUT chain (401 unauth → 401 no org → 404
// non-existent agent → 200 sets ids + DB read-after-write
// → 200 replaces atomically → 200 clears with empty array
// → 400 cross-org connector id),
// (3) zero-token capability chain (403 sandbox without
// agent:read capability for both GET and PUT).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
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

const trackCompose = createFixtureTracker<TeamComposeFixture>((fixture) => {
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

function client() {
  return setupApp({ context })(zeroAgentCustomConnectorsContract);
}

describe("BDD GET /api/zero/agents/:id/custom-connectors — auth + not-found + cli chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no org → 200 empty enabledIds for a fresh agent → 200 accepts CLI token → 404 non-existent agent → 404 cross-org agent (no existence leak)", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      client().get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a seeded fixture + a session with no org.

    // When + Then: 401.
    const noOrgFixture = await trackCompose(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFixture.userId, null);
    const noOrg = await accept(
      client().get({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with one agent + a session for
    // the owner.

    // When + Then: 200 — enabledIds is empty.
    const emptyFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);
    const emptyAgentId = emptyFixture.composeIds[0]!;
    const emptyResponse = await accept(
      client().get({
        params: { id: emptyAgentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(emptyResponse.body).toStrictEqual({ enabledIds: [] });

    // Given: a fixture with one agent + a CLI token for
    // the owner.

    // When + Then: 200 — CLI token is accepted +
    // enabledIds is empty.
    const cliFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "CLI Agent" }] },
        context.signal,
      ),
    );
    const cliAgentId = cliFixture.composeIds[0]!;
    const cliResponse = await accept(
      client().get({
        params: { id: cliAgentId },
        headers: await cliAuthHeaders(cliFixture),
      }),
      [200],
    );
    expect(cliResponse.body).toStrictEqual({ enabledIds: [] });

    // Given: a fixture + a session for the owner + a
    // random non-existent agent id.

    // When + Then: 404 — agent not found.
    const notFoundFixture = await trackCompose(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(notFoundFixture.userId, notFoundFixture.orgId);
    const unknownId = randomUUID();
    const notFoundResponse = await accept(
      client().get({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });

    // Given: a fixture in another org with one agent +
    // a session in my org for the owner.

    // When + Then: 404 — the agent is invisible in the
    // active org (no existence leak).
    const otherFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Agent" }] },
        context.signal,
      ),
    );
    const sharedId = otherFixture.composeIds[0]!;
    const myFixture = await trackCompose(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);
    const crossOrgResponse = await accept(
      client().get({
        params: { id: sharedId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(crossOrgResponse.body).toStrictEqual({
      error: { message: `Agent not found: ${sharedId}`, code: "NOT_FOUND" },
    });
  });
});

describe("BDD PUT /api/zero/agents/:id/custom-connectors — auth + persistence + validation chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no org → 404 non-existent agent → 200 sets ids + DB read-after-write → 200 replaces atomically → 200 clears with empty array → 400 cross-org connector id", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      client().update({
        params: { id: randomUUID() },
        headers: {},
        body: { enabledIds: [] },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a seeded fixture + a session with no org.

    // When + Then: 401.
    const noOrgFixture = await trackCompose(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFixture.userId, null);
    const noOrg = await accept(
      client().update({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + a session for the owner + a
    // random non-existent agent id.

    // When + Then: 404 — agent not found.
    const notFoundFixture = await trackCompose(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(notFoundFixture.userId, notFoundFixture.orgId);
    const unknownId = randomUUID();
    const notFoundResponse = await accept(
      client().update({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });

    // Given: a fixture with one agent + 2 seeded
    // connectors in the same org + a session for the
    // owner.

    // When + Then: 200 — enabledIds reflects the
    // request + the DB row is persisted.
    const setFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const setAgentId = setFixture.composeIds[0]!;
    const c1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: setFixture.orgId, userId: setFixture.userId, slug: "round-a" },
        context.signal,
      ),
    );
    const c2 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        { orgId: setFixture.orgId, userId: setFixture.userId, slug: "round-b" },
        context.signal,
      ),
    );
    mocks.clerk.session(setFixture.userId, setFixture.orgId);
    const setResponse = await accept(
      client().update({
        params: { id: setAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [c1.connectorId, c2.connectorId] },
      }),
      [200],
    );
    expect(new Set(setResponse.body.enabledIds)).toStrictEqual(
      new Set([c1.connectorId, c2.connectorId]),
    );
    const setPersisted = await getEnabledIds(
      setFixture.orgId,
      setFixture.userId,
      setAgentId,
    );
    expect(new Set(setPersisted)).toStrictEqual(
      new Set([c1.connectorId, c2.connectorId]),
    );

    // Given: the same agent + 2 connectors in the same
    // org + a session for the owner.

    // When + Then: 200 — the second update atomically
    // replaces the prior set + only c2 is persisted.
    const replaceFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const replaceAgentId = replaceFixture.composeIds[0]!;
    const r1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        {
          orgId: replaceFixture.orgId,
          userId: replaceFixture.userId,
          slug: "rep-1",
        },
        context.signal,
      ),
    );
    const r2 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        {
          orgId: replaceFixture.orgId,
          userId: replaceFixture.userId,
          slug: "rep-2",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(replaceFixture.userId, replaceFixture.orgId);
    await accept(
      client().update({
        params: { id: replaceAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [r1.connectorId] },
      }),
      [200],
    );
    await accept(
      client().update({
        params: { id: replaceAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [r2.connectorId] },
      }),
      [200],
    );
    const replacePersisted = await getEnabledIds(
      replaceFixture.orgId,
      replaceFixture.userId,
      replaceAgentId,
    );
    expect(replacePersisted).toStrictEqual([r2.connectorId]);

    // Given: the same agent with one enabled id + a
    // session for the owner + an empty enabledIds array.

    // When + Then: 200 — all authorizations are
    // cleared + no rows remain.
    const clearFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const clearAgentId = clearFixture.composeIds[0]!;
    const clr1 = await trackConnector(
      store.set(
        seedCustomConnectorOrg$,
        {
          orgId: clearFixture.orgId,
          userId: clearFixture.userId,
          slug: "clr-1",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(clearFixture.userId, clearFixture.orgId);
    await accept(
      client().update({
        params: { id: clearAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [clr1.connectorId] },
      }),
      [200],
    );
    await accept(
      client().update({
        params: { id: clearAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [] },
      }),
      [200],
    );
    const clearPersisted = await getEnabledIds(
      clearFixture.orgId,
      clearFixture.userId,
      clearAgentId,
    );
    expect(clearPersisted).toStrictEqual([]);

    // Given: a fixture with one agent + a connector
    // seeded in a different org + a session for the
    // owner.

    // When + Then: 400 — VALIDATION_ERROR + nothing is
    // persisted.
    const crossOrgFixture = await trackCompose(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Test Agent" }] },
        context.signal,
      ),
    );
    const crossOrgAgentId = crossOrgFixture.composeIds[0]!;
    const otherConnector = await trackConnector(
      store.set(seedCustomConnectorOrg$, { slug: "other-org" }, context.signal),
    );
    mocks.clerk.session(crossOrgFixture.userId, crossOrgFixture.orgId);
    const crossOrgResponse = await accept(
      client().update({
        params: { id: crossOrgAgentId },
        headers: { authorization: "Bearer clerk-session" },
        body: { enabledIds: [otherConnector.connectorId] },
      }),
      [400],
    );
    expect(crossOrgResponse.body).toStrictEqual({
      error: {
        message: `Unknown custom connector ids: ${otherConnector.connectorId}`,
        code: "VALIDATION_ERROR",
      },
    });
    const crossOrgPersisted = await getEnabledIds(
      crossOrgFixture.orgId,
      crossOrgFixture.userId,
      crossOrgAgentId,
    );
    expect(crossOrgPersisted).toStrictEqual([]);
  });
});

describe("BDD /api/zero/agents/:id/custom-connectors — zero-token capability chain", () => {
  it("gwt-wt-wt: 403 sandbox without agent:read capability for both GET and PUT", async () => {
    // Given: a zero token with the wrong capability.

    // When + Then: 403 — FORBIDDEN on GET.
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
    const getResponse = await accept(
      client().get({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(getResponse.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });

    // When + Then: 403 — FORBIDDEN on PUT.
    const putResponse = await accept(
      client().update({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: { enabledIds: [] },
      }),
      [403],
    );
    expect(putResponse.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });
});
