import { randomUUID } from "node:crypto";

import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

// The custom-connectors GET/PUT behaviour has migrated to
// `agent-connectors.bdd.test.ts` (API-first BDD). This file retains only the
// CLI-token acceptance case, which cannot be set up through the public API yet
// (no route mints a CLI token in tests) — tracked as GAP-CLI-TOKEN in
// `api.bdd.md`.
const context = testContext();
const store = createStore();

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

describe("GET /api/zero/agents/:id/custom-connectors", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("accepts a CLI token for the agent owner", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "CLI Agent" }] },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledIds: [] });
  });
});
