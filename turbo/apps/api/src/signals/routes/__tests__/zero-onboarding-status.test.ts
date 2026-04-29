import { randomUUID } from "node:crypto";

import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroOnboardingStatusRoutes } from "../zero-onboarding-status";
import {
  deleteOnboardingStatusOrg,
  seedOnboardingStatusOrg,
  type OnboardingStatusFixture,
} from "./helpers/zero-onboarding-status";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/onboarding/status", () => {
  const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
    return deleteOnboardingStatusOrg(store, fixture);
  });

  it("returns onboarding required when the session has no active org", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({
      context,
      routes: zeroOnboardingStatusRoutes("api"),
    })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: false,
      hasOrg: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("requires admin onboarding when the org has no default agent", async () => {
    const fixture = await track(seedOnboardingStatusOrg(store));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({
      context,
      routes: zeroOnboardingStatusRoutes("api"),
    })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("returns completed onboarding with default agent metadata", async () => {
    const fixture = await track(
      seedOnboardingStatusOrg(store, {
        defaultAgent: {
          displayName: "Support",
          description: "Handles customer questions",
        },
        onboardingDone: true,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({
      context,
      routes: zeroOnboardingStatusRoutes("api"),
    })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: fixture.composeId,
      defaultAgentMetadata: {
        displayName: "Support",
        description: "Handles customer questions",
      },
    });
  });
});
