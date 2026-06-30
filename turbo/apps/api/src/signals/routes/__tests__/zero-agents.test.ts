import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

function hideSlackConnectorAuthMethods(): () => void {
  const authMethods = CONNECTOR_TYPES.slack.authMethods;
  const original = Object.fromEntries(Object.entries(authMethods));

  for (const [key, config] of Object.entries(authMethods)) {
    Object.defineProperty(authMethods, key, {
      value: { ...config, visible: false },
      configurable: true,
      enumerable: true,
    });
  }

  return () => {
    for (const [key, config] of Object.entries(original)) {
      Object.defineProperty(authMethods, key, {
        value: config,
        configurable: true,
        enumerable: true,
      });
    }
  };
}

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const restoreConnectorRegistry: (() => void)[] = [];

  afterEach(() => {
    while (restoreConnectorRegistry.length > 0) {
      restoreConnectorRegistry.pop()?.();
    }
  });

  const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
    return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
  });

  it("filters connector grants for connector types removed from the registry", async () => {
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, { defaultAgent: {} }, context.signal),
    );
    const agentId = fixture.composeId!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroUserConnectorsContract);

    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledTypes: ["slack", "github"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    restoreConnectorRegistry.push(hideSlackConnectorAuthMethods());
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
