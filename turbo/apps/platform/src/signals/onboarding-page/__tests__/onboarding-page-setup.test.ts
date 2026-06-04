import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setupOnboardingPage$ } from "../onboarding-page-setup.ts";
import { zeroSelectedConnectors$ } from "../../zero-page/zero-onboarding.ts";
import { markCompletedBillingCheckout$ } from "../../zero-page/billing.ts";
import { pathname, search } from "../../location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

const context = testContext();
const mockApi = createMockApi(context);

function mockAdminOnboarding() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    }),
  );
}

// A user who doesn't need onboarding — a non-admin, or an admin whose
// workspace is already set up. The backend reports needsOnboarding: false.
function mockNoOnboardingNeeded() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: false,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
  );
}

describe("setupOnboardingPage$ — redirect when onboarding is not needed", () => {
  it("redirects to / when the user does not need onboarding and there is no use-case link", async () => {
    mockNoOnboardingNeeded();

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(pathname()).toBe("/");
  });

  it("stays on /onboarding for a use-case deep link even when onboarding is not needed", async () => {
    mockNoOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(pathname()).toBe("/onboarding");
  });

  it("continues to the default agent after onboarding billing succeeds", async () => {
    mockNoOnboardingNeeded();
    context.store.set(markCompletedBillingCheckout$, "pro");

    detachedSetupPage({
      context,
      path: "/onboarding",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(pathname()).toBe(
      "/agents/c0000000-0000-4000-a000-000000000001/chat",
    );
  });

  it("reconciles the checkout session before resuming onboarding", async () => {
    let completedSessionId: string | null = null;
    mockNoOnboardingNeeded();
    server.use(
      mockApi(zeroBillingCheckoutContract.complete, ({ body, respond }) => {
        completedSessionId = body.sessionId;
        return respond(200, { completed: true });
      }),
    );
    context.store.set(markCompletedBillingCheckout$, "pro", "cs_test_resume");

    detachedSetupPage({
      context,
      path: "/onboarding",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(completedSessionId).toBe("cs_test_resume");
    expect(pathname()).toBe(
      "/agents/c0000000-0000-4000-a000-000000000001/chat",
    );
  });
});

describe("setupOnboardingPage$ — ?connector= consumption", () => {
  it("pre-selects valid connectors and preserves ?connector= on the URL", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello&connector=gmail,slack,unknown_type",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const selected = context.store.get(zeroSelectedConnectors$);
    expect(selected).toContain("gmail");
    expect(selected).toContain("slack");
    expect(selected).not.toContain("unknown_type");

    expect(pathname()).toBe("/onboarding");
    const remaining = new URLSearchParams(search());
    // ?connector= stays on the URL so a refresh during onboarding restores
    // the same pre-selection; it falls away naturally on step 4 navigation.
    expect(remaining.get("connector")).toBe("gmail,slack,unknown_type");
    // ?prompt= must be preserved so it flows through to chat completion
    expect(remaining.get("prompt")).toBe("hello");
  });

  it("deduplicates repeated connector values", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?connector=gmail,gmail,gmail",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const selected = context.store.get(zeroSelectedConnectors$);
    const gmailCount = selected.filter((c) => {
      return c === "gmail";
    }).length;
    expect(gmailCount).toBe(1);
  });

  it("ignores feature-disabled connectors from ?connector=", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?connector=bentoml,gmail",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const selected = context.store.get(zeroSelectedConnectors$);
    expect(selected).toContain("gmail");
    expect(selected).not.toContain("bentoml");
  });

  it("leaves selections untouched when ?connector= is absent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    await context.store.set(setupOnboardingPage$, context.signal);

    const selected = context.store.get(zeroSelectedConnectors$);
    expect(selected).toStrictEqual([]);
    expect(search()).toBe("");
  });
});
