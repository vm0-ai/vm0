import { randomUUID } from "node:crypto";

import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSkillsForFixture$,
  seedAgentForInstructions$,
  seedSkillsFixture$,
  seedUserConnector$,
  type SkillsFixture,
} from "./helpers/zero-skills";

// The GET user-connectors happy/boundary cases have migrated to
// `agent-connectors.bdd.test.ts` (API-first BDD). This file retains only the
// cases that cannot be built through the public API: CLI-token auth
// (GAP-CLI-TOKEN) and registry/feature-switch filtering, which requires a
// connector grant for a type the update API would reject
// (GAP-REMOVED-CONNECTOR / GAP-FEATURE-GATED-CONNECTOR) — see `api.bdd.md`.
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

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("accepts a CLI token for the agent owner", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const response = await accept(
      apiClient().get({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture),
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

  it("ignores connector grants for feature-flag-disabled types", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    // `spotify` is a valid connector type but gated behind a feature switch
    // that is off by default, so it must not be returned to the client. If it
    // were, the client would replay it on the next update and the update
    // endpoint would reject the whole request as unavailable.
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "spotify",
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
