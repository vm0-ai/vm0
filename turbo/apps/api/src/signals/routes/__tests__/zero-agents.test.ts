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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
    return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
  });

  it("filters connector grants for connector types removed from the registry", async () => {
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, { defaultAgent: {} }, context.signal),
    );
    const agentId = fixture.composeId!;
    await store
      .set(writeDb$)
      .insert(userConnectors)
      .values([
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
