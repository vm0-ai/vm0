import { randomUUID } from "node:crypto";

import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore } from "ccstate";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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

// BDD migration of the legacy `zero-user-connectors.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary + 404 chain (401 unauth → 401 no-org → 404
// non-existent agent → 404 cross-org agent), (2) 200 happy
// path (new agent with no connectors → owner via CLI token),
// (3) 200 filter chain (removed connector types excluded →
// feature-flag-disabled types excluded).
//
// Service-Level Exception: agent + connector rows are seeded
// directly via `writeDb$` because no public route creates them
// in this configuration.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUserConnectorsContract);
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

const track = createFixtureTracker<SkillsFixture>((fixture) => {
  return store.set(deleteSkillsForFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/agents/:id/user-connectors — auth + 404 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 404 non-existent agent → 404 cross-org agent", async () => {
    const c = apiClient();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.get({ params: { id: randomUUID() }, headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session for a fresh user in a fresh org.
    const missingFx = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(missingFx.userId, missingFx.orgId);

    // When + Then: 404 — agent not found.
    const fakeId = randomUUID();
    const missing = await accept(
      c.get({ params: { id: fakeId }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
    });

    // Given: an agent in another org; authenticate as a
    // different user in a different org.
    const ownerFx = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: ownerFx.orgId, userId: ownerFx.userId },
      context.signal,
    );
    const callerFx = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(callerFx.userId, callerFx.orgId);

    // When + Then: 404 — cross-org access is non-existence-
    // leaking.
    const crossOrg = await accept(
      c.get({ params: { id: agentId }, headers: authHeaders() }),
      [404],
    );
    expect(crossOrg.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/zero/agents/:id/user-connectors — 200 happy path", () => {
  it("gwt-wt-wt: new agent with no connectors returns empty enabledTypes → owner via CLI token also gets empty enabledTypes", async () => {
    const c = apiClient();

    // Given: a fresh user + an agent they own.
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 + empty enabledTypes.
    const empty = await accept(
      c.get({ params: { id: agentId }, headers: authHeaders() }),
      [200],
    );
    expect(empty.body).toStrictEqual({ enabledTypes: [] });

    // Given: a CLI token for the same user.
    const cliHeaders = await cliAuthHeaders(fixture);

    // When + Then: 200 + empty enabledTypes via CLI auth.
    const viaCli = await accept(
      c.get({ params: { id: agentId }, headers: cliHeaders }),
      [200],
    );
    expect(viaCli.body).toStrictEqual({ enabledTypes: [] });
  });
});

describe("BDD GET /api/zero/agents/:id/user-connectors — 200 filter chain", () => {
  it("gwt-wt-wt: removed connector types are excluded → feature-flag-disabled types are excluded", async () => {
    const c = apiClient();

    // Given: an agent with one valid connector grant + one
    // grant for a removed connector type ("nano-banana").
    const removedFx = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: removedAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: removedFx.orgId, userId: removedFx.userId },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: removedFx.orgId,
        userId: removedFx.userId,
        agentId: removedAgentId,
        connectorType: "nano-banana",
      },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: removedFx.orgId,
        userId: removedFx.userId,
        agentId: removedAgentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(removedFx.userId, removedFx.orgId);

    // When + Then: only the valid ("github") type is returned.
    const removed = await accept(
      c.get({ params: { id: removedAgentId }, headers: authHeaders() }),
      [200],
    );
    expect(removed.body).toStrictEqual({ enabledTypes: ["github"] });

    // Given: a fresh agent + a connector grant for a
    // feature-flag-disabled type ("spotify") + a valid grant.
    const flagFx = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: flagAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: flagFx.orgId, userId: flagFx.userId },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: flagFx.orgId,
        userId: flagFx.userId,
        agentId: flagAgentId,
        connectorType: "spotify",
      },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: flagFx.orgId,
        userId: flagFx.userId,
        agentId: flagAgentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(flagFx.userId, flagFx.orgId);

    // When + Then: only the valid type is returned.
    const flag = await accept(
      c.get({ params: { id: flagAgentId }, headers: authHeaders() }),
      [200],
    );
    expect(flag.body).toStrictEqual({ enabledTypes: ["github"] });
  });
});
