import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for onboarding status + setup. Creating the default
// agent is free, so the admin setup happy path (and the status it produces) is
// reachable end-to-end via the API. The disabled-connector 422, paid-org
// payment handling and Clerk-org name/slug update variants need seeded
// connectors / tiers / Clerk mocks and stay in the kept legacy. See
// `api.bdd.md` (CHAIN-ONBOARDING-REJECTIONS).
const context = testContext();

describe("onboarding status + setup (API-first BDD)", () => {
  it("status rejects unauthenticated callers and reports onboarding state by role", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.onboardingStatus.getStatus({ headers: {} }), [401]);

    // A session with no active org needs onboarding but has no org.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.onboardingStatus.getStatus({ headers: SESSION_AUTH }),
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

    // A fresh admin org with no default agent still needs onboarding.
    api.actAsAdmin();
    const admin = await accept(
      api.onboardingStatus.getStatus({ headers: SESSION_AUTH }),
      [200],
    );
    expect(admin.body).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    // A non-admin member never needs onboarding.
    api.actAsMember({
      userId: "user_onboarding_member",
      orgId: "org_onboarding",
    });
    const member = await accept(
      api.onboardingStatus.getStatus({ headers: SESSION_AUTH }),
      [200],
    );
    expect(member.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("setup rejects unauthenticated / org-less / non-admin callers", async () => {
    const api = createBddApi(context);
    const body = { displayName: "Zero" };

    // Unauthenticated.
    await accept(api.onboardingSetup.setup({ headers: {}, body }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.onboardingSetup.setup({ headers: SESSION_AUTH, body }),
      [401],
    );

    // Org members cannot run setup.
    api.actAsMember({
      userId: "user_onboarding_member",
      orgId: "org_onboarding",
    });
    const member = await accept(
      api.onboardingSetup.setup({ headers: SESSION_AUTH, body }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can run onboarding setup",
        code: "FORBIDDEN",
      },
    });
  });

  it("setup creates the default agent for an admin and the status reflects it", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // When the admin completes setup, a default agent is created.
    const created = await accept(
      api.onboardingSetup.setup({
        headers: SESSION_AUTH,
        body: {
          displayName: "My Assistant",
          sound: "professional",
          avatarUrl: "preset:0",
          timezone: "America/Los_Angeles",
          role: "founder",
        },
      }),
      [200],
    );
    const { agentId } = created.body;
    expect(agentId).toBeTruthy();

    // The new agent shows up in the agent list.
    const agents = await accept(
      api.agents.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      agents.body.some((agent) => {
        return agent.agentId === agentId;
      }),
    ).toBeTruthy();

    // Onboarding status now reports the default agent.
    const status = await accept(
      api.onboardingStatus.getStatus({ headers: SESSION_AUTH }),
      [200],
    );
    expect(status.body.hasDefaultAgent).toBeTruthy();
    expect(status.body.defaultAgentId).toBe(agentId);
  });
});
