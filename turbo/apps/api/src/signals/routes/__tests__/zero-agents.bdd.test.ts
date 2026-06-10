import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteOnboardingStatusOrg$,
  seedOnboardingStatusOrg$,
  type OnboardingStatusFixture,
} from "./helpers/zero-onboarding-status";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-agents.test.ts`. The legacy test
// directly seeded two connector grants (`nano-banana` and `github`)
// and verified the route filters out the removed type. The BDD
// version keeps the same Given (a fresh org + a default agent with
// seeded grants) and asserts on the public contract's `enabledTypes`
// array. The 1 legacy `it()` is preserved as a BDD `it()`.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
  return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
});

describe("BDD GET /api/zero/agents/:id/user-connectors — registry filter", () => {
  it("filters connector grants for connector types removed from the registry", async () => {
    // Given: a fresh user/org with a default agent; the caller is
    // authenticated as the owner.
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, { defaultAgent: {} }, context.signal),
    );
    const agentId = fixture.composeId!;

    // And: the agent has connector grants for `nano-banana` (no
    // longer in the registry) and `github` (still in the registry).
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userConnectors).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "nano-banana",
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "github",
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the route returns only the registered type.
    const client = setupApp({ context })(zeroUserConnectorsContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.enabledTypes).toStrictEqual(["github"]);
  });
});
