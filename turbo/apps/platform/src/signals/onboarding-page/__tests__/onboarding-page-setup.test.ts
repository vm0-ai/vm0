import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setupOnboardingPage$ } from "../onboarding-page-setup.ts";
import { zeroSelectedConnectors$ } from "../../zero-page/zero-onboarding.ts";
import { pathname, search } from "../../location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { onboardingStatusContract } from "@vm0/core";

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

  it("leaves selections untouched when ?connector= is absent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    await context.store.set(setupOnboardingPage$, context.signal);

    const selected = context.store.get(zeroSelectedConnectors$);
    expect(selected).toStrictEqual([]);
    expect(search()).toBe("");
  });
});
