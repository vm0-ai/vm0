import { zeroComposesMetadataContract } from "@vm0/api-contracts/contracts/zero-composes";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

// The compose metadata-update full/partial/member/404 cases have migrated to
// `zero-composes-by-id.bdd.test.ts` (API-first BDD). This file retains only the
// "fresh zero_agents row" case: it exercises the INSERT branch of the upsert,
// reachable only from a compose that has no `zero_agents` row. API-created
// agents always provision that row (they take the UPDATE branch), so this stays
// legacy (GAP-STANDALONE-COMPOSE in `api.bdd.md`).
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("PATCH /api/zero/composes/:id/metadata", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("updates compose metadata on a fresh zero_agents row", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: composeId },
        body: {
          displayName: "Test Display Name",
          description: "Test description",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("Test Display Name");
    expect(row?.description).toBe("Test description");
    expect(row?.sound).toBeNull();
  });
});
