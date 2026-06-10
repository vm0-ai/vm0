import { randomUUID } from "node:crypto";

import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

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
  type SkillsFixture,
} from "./helpers/zero-skills";

// The PUT user-connectors happy/validation/boundary cases have migrated to
// `agent-connectors.bdd.test.ts` (API-first BDD). This file retains the cases
// that cannot be set up through the public API: CLI-token auth (GAP-CLI-TOKEN)
// and the stale-recompose branch, which requires forcing a stale compose head
// version that no API exposes (GAP-STALE-RECOMPOSE) — see `api.bdd.md`.
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

describe("PUT /api/zero/agents/:id/user-connectors", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  async function getEnabledTypes(
    orgId: string,
    userId: string,
    agentId: string,
  ): Promise<string[]> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, orgId),
          eq(userConnectors.userId, userId),
          eq(userConnectors.agentId, agentId),
        ),
      );
    return rows.map((r) => {
      return r.connectorType;
    });
  }

  async function getAgentHeadVersion(
    agentId: string,
  ): Promise<string | null | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, agentId));
    return row?.headVersionId;
  }

  it("accepts a CLI token when updating connector permissions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );

    expect(response.body.enabledTypes).toStrictEqual(["github"]);
    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual(["github"]);
  });

  it("recomposes the agent when its compose head version is stale", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const STALE_VERSION = "f".repeat(64);
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(agentComposes)
      .set({ headVersionId: STALE_VERSION })
      .where(eq(agentComposes.id, agentId));
    await expect(getAgentHeadVersion(agentId)).resolves.toBe(STALE_VERSION);

    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );

    const after = await getAgentHeadVersion(agentId);
    expect(after).not.toBe(STALE_VERSION);
    expect(after).toMatch(/^[a-f0-9]{64}$/);

    const [versionRow] = await writeDb
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, after!));
    expect(versionRow?.id).toBe(after);
  });
});
