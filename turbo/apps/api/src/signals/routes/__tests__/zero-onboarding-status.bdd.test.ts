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

// BDD migration of the legacy `zero-onboarding-status.test.ts`.
// The 10 legacy `it()`s (including the `it.each` for pro/team)
// collapse into 3 BDD `it()`s: (1) auth + no-org chain (401
// unauth → 200 no-org returns needsOnboarding: true), (2) 200
// full matrix (no default agent → default agent no metadata →
// default agent + pending payment → pro tier pending payment
// ignored → team tier pending payment ignored → default agent
// with metadata), (3) isolation chain (non-admin never reports
// needsOnboarding → orphan compose is no default agent →
// cross-org default agent is ignored).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function client() {
  return setupApp({ context })(onboardingStatusContract);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
  return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
});

describe("BDD GET /api/zero/onboarding/status — auth + no-org chain", () => {
  it("gwt-wt-wt: 401 unauth → 200 no-org returns needsOnboarding: true", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(client().getStatus({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: 200 with the no-org onboarding shape.
    const noOrg = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(noOrg.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: false,
      hasOrg: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
});

describe("BDD GET /api/zero/onboarding/status — 200 full matrix", () => {
  it("gwt-wt-wt: no default agent → default agent with no metadata → default agent + pending payment → pro tier pending payment ignored → team tier pending payment ignored → default agent with metadata", async () => {
    // Given: an org with no default agent.
    const noAgentFx = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(noAgentFx.userId, noAgentFx.orgId, "org:admin");

    // When + Then: 200 with needsOnboarding: true.
    const noAgent = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(noAgent.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    // Given: an org with a default agent + no metadata.
    const completedFx = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
        },
        context.signal,
      ),
    );
    mocks.clerk.session(completedFx.userId, completedFx.orgId, "org:admin");

    // When + Then: 200 with needsOnboarding: false.
    const completed = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: completedFx.composeId,
      defaultAgentMetadata: null,
    });

    // Given: a default agent + onboarding payment pending.
    const pendingFx = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
          onboardingPaymentPending: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(pendingFx.userId, pendingFx.orgId, "org:admin");

    // When + Then: needsOnboarding stays true while payment is
    // pending.
    const pending = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(pending.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: pendingFx.composeId,
      defaultAgentMetadata: null,
    });

    // Given: a pro-tier org with a stale pending payment.
    const proFx = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
          onboardingPaymentPending: true,
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(proFx.userId, proFx.orgId, "org:admin");

    // When + Then: 200 with needsOnboarding: false (pro tier
    // ignores stale pending).
    const pro = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(pro.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: proFx.composeId,
      defaultAgentMetadata: null,
    });

    // Given: a team-tier org with a stale pending payment.
    const teamFx = await track(
      store.set(
        seedOnboardingStatusOrg$,
        {
          defaultAgent: {},
          onboardingPaymentPending: true,
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(teamFx.userId, teamFx.orgId, "org:admin");

    // When + Then: 200 with needsOnboarding: false (team tier
    // ignores stale pending).
    const team = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(team.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: teamFx.composeId,
      defaultAgentMetadata: null,
    });

    // Given: an org with a default agent that has metadata.
    const metaFx = await track(
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
    mocks.clerk.session(metaFx.userId, metaFx.orgId, "org:admin");

    // When + Then: 200 with the metadata echoed.
    const meta = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(meta.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: metaFx.composeId,
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
    });
  });
});

describe("BDD GET /api/zero/onboarding/status — isolation chain", () => {
  it("gwt-wt-wt: non-admin never reports needsOnboarding → orphan compose is no default agent → cross-org default agent is ignored", async () => {
    // Given: an org with no default agent; authenticate as a
    // non-admin.
    const nonAdminFx = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(nonAdminFx.userId, nonAdminFx.orgId, "org:member");

    // When + Then: 200 with needsOnboarding: false.
    const nonAdmin = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(nonAdmin.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    // Given: an org whose default_agent_id points to an
    // `agent_composes` row that has no matching `zero_agents`
    // row.
    const orphanFx = await track(
      store.set(seedOrphanDefaultAgent$, undefined, context.signal),
    );
    mocks.clerk.session(orphanFx.userId, orphanFx.orgId, "org:admin");

    // When + Then: needsOnboarding: true (orphan compose is
    // treated as no default agent).
    const orphan = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(orphan.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    // Given: an org whose default_agent_id points to a
    // fully-formed compose owned by a different org.
    const crossOrgFx = await track(
      store.set(seedCrossOrgDefaultAgent$, undefined, context.signal),
    );
    mocks.clerk.session(crossOrgFx.userId, crossOrgFx.orgId, "org:admin");

    // When + Then: needsOnboarding: true (cross-org compose
    // is ignored).
    const crossOrg = await accept(
      client().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(crossOrg.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
});
