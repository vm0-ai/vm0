import { randomUUID } from "node:crypto";

import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteOnboardingStatusOrg$,
  seedCrossOrgDefaultAgent$,
  seedOnboardingStatusOrg$,
  seedOrphanDefaultAgent$,
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
    return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(onboardingStatusContract);

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns onboarding required when the session has no active org", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(onboardingStatusContract);

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
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

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

  it("returns completed onboarding for admin with default agent and no metadata", async () => {
    const fixture = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: fixture.composeId,
      defaultAgentMetadata: null,
    });
  });

  it("keeps onboarding active while default agent payment is pending", async () => {
    const fixture = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
          onboardingPaymentPending: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

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
      hasDefaultAgent: true,
      defaultAgentId: fixture.composeId,
      defaultAgentMetadata: null,
    });
  });

  it.each(["pro", "team"] as const)(
    "ignores stale pending onboarding payment for %s orgs",
    async (tier) => {
      const fixture = await track(
        store.set(
          seedOnboardingStatusOrg$,
          {
            defaultAgent: {},
            onboardingPaymentPending: true,
            tier,
          },
          context.signal,
        ),
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const client = setupApp({ context })(onboardingStatusContract);

      const response = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        needsOnboarding: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: fixture.composeId,
        defaultAgentMetadata: null,
      });
    },
  );

  it("returns default agent metadata when the compose has metadata", async () => {
    const fixture = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {
            displayName: "My Agent",
            sound: "friendly",
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: fixture.composeId,
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
    });
  });

  it("never reports needsOnboarding for a non-admin member", async () => {
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(onboardingStatusContract);

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
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("treats orphan compose (missing zero_agents row) as no default agent", async () => {
    const fixture = await track(
      store.set(seedOrphanDefaultAgent$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

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

  it("ignores a default agent row from another org", async () => {
    const fixture = await track(
      store.set(seedCrossOrgDefaultAgent$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(onboardingStatusContract);

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
});
