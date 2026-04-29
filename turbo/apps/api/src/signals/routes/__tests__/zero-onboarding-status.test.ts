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

const context = testContext();
const store = createStore();

function mockSession(
  userId: string,
  orgId: string | null,
  orgRole: "org:admin" | "org:member" | undefined = orgId
    ? "org:admin"
    : undefined,
): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole,
      };
    },
  });
}

describe("GET /api/zero/onboarding/status", () => {
  const fixtures: OnboardingStatusFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteOnboardingStatusOrg(store, fixture);
      }
    }
  });

  async function track(
    fixturePromise: Promise<OnboardingStatusFixture>,
  ): Promise<OnboardingStatusFixture> {
    const fixture = await fixturePromise;
    fixtures.push(fixture);
    return fixture;
  }

  it("returns onboarding required when the session has no active org", async () => {
    mockSession(`user_${randomUUID()}`, null);

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
    mockSession(fixture.userId, fixture.orgId, "org:admin");

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
    mockSession(fixture.userId, fixture.orgId, "org:member");

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

  it("requires authentication", async () => {
    const client = setupApp({
      context,
      routes: zeroOnboardingStatusRoutes("api"),
    })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
