import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { onboardGuard$ } from "../onboard-guard.ts";
import { pathname } from "../../location.ts";

const context = testContext();

function mockOnboardingStatus(body: {
  needsOnboarding: boolean;
  hasOrg: boolean;
  hasDefaultAgent: boolean;
}) {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: body.needsOnboarding,
        isAdmin: true,
        hasOrg: body.hasOrg,
        hasDefaultAgent: body.hasDefaultAgent,
        defaultAgentId: body.hasDefaultAgent
          ? "c0000000-0000-4000-a000-000000000001"
          : null,
        defaultAgentMetadata: body.hasDefaultAgent
          ? { displayName: "Zero" }
          : null,
      });
    }),
  );
}

describe("onboardGuard$", () => {
  it("should not redirect when onboarding is not needed", async () => {
    mockOnboardingStatus({
      needsOnboarding: false,
      hasOrg: true,
      hasDefaultAgent: true,
    });

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const redirected = await context.store.set(onboardGuard$, context.signal);

    expect(redirected).toBeFalsy();
  });

  it("should redirect to /onboarding when org needs setup and user has no other orgs", async () => {
    mockOnboardingStatus({
      needsOnboarding: true,
      hasOrg: true,
      hasDefaultAgent: false,
    });

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const redirected = await context.store.set(onboardGuard$, context.signal);

    expect(redirected).toBeTruthy();
    expect(pathname()).toBe("/onboarding");
  });

  it("should redirect to /select-org when org is deleted but user has other memberships", async () => {
    mockOnboardingStatus({
      needsOnboarding: true,
      hasOrg: false,
      hasDefaultAgent: false,
    });

    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      org: {
        activeOrg: null,
        memberships: [{ id: "org_other_1" }, { id: "org_other_2" }],
      },
    });

    const redirected = await context.store.set(onboardGuard$, context.signal);

    expect(redirected).toBeTruthy();
    expect(pathname()).toBe("/select-org");
  });

  it("should redirect to /onboarding when org is deleted and user has no memberships", async () => {
    mockOnboardingStatus({
      needsOnboarding: true,
      hasOrg: false,
      hasDefaultAgent: false,
    });

    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      org: {
        activeOrg: null,
        memberships: [],
      },
    });

    const redirected = await context.store.set(onboardGuard$, context.signal);

    expect(redirected).toBeTruthy();
    expect(pathname()).toBe("/onboarding");
  });
});
