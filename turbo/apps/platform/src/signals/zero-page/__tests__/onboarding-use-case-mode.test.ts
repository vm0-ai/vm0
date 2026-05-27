import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setupOnboardingPage$ } from "../../onboarding-page/onboarding-page-setup.ts";
import {
  onboardingEagerInitialized$,
  onboardingIsUseCase$,
  onboardingPromptDraft$,
  setOnboardingPromptDraft$,
  setZeroWorkspaceName$,
  zeroSelectedConnectors$,
} from "../zero-onboarding.ts";
import {
  onboardingBackendWillAuthorizeConnectors$,
  onboardingEffectiveStep$,
  onboardingNextLabel$,
  onboardingResolvedPrompt$,
  onboardingShowDialog$,
  onboardingStepNext$,
  onboardingVisibleSteps$,
} from "../zero-onboarding-actions.ts";
import { pathname } from "../../location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
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

// A non-admin user. Non-admins never need onboarding, but a use-case deep
// link still drops them into the condensed step-3 flow.
function mockNonAdmin(defaultAgentId: string) {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: false,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId,
        defaultAgentMetadata: null,
      });
    }),
  );
}

describe("onboarding use-case mode (?prompt=...&connector=...)", () => {
  it("flags use-case mode and seeds the prompt draft from the URL", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=clone+vm0%2C+scan+tech+debt&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(context.store.get(onboardingIsUseCase$)).toBeTruthy();
    expect(context.store.get(onboardingPromptDraft$)).toBe(
      "clone vm0, scan tech debt",
    );
    expect(context.store.get(zeroSelectedConnectors$)).toContain("github");
  });

  it("enters use-case mode when only ?prompt= is present (connector is optional)", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(context.store.get(onboardingIsUseCase$)).toBeTruthy();
    expect(context.store.get(onboardingPromptDraft$)).toBe("hello");
  });

  it("does not enter use-case mode when only ?connector= is present", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(context.store.get(onboardingIsUseCase$)).toBeFalsy();
  });

  it("admin visible steps are step 1 + step 3 in use-case mode", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hi&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const visible = await context.store.get(onboardingVisibleSteps$);
    expect(visible).toStrictEqual(["1", "3"]);
  });

  it("non-admin visible steps reduce to just step 3 in use-case mode", async () => {
    mockNonAdmin("a0000000-0000-4000-a000-000000000001");

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hi&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const visible = await context.store.get(onboardingVisibleSteps$);
    expect(visible).toStrictEqual(["3"]);
  });

  it("admin visible steps are the regular flow outside use-case mode", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const visible = await context.store.get(onboardingVisibleSteps$);
    // No use-case link → regular admin flow: name workspace, pick tools,
    // then start the Pro trial checkout.
    expect(visible).toStrictEqual(["1", "2", "4"]);
  });

  it("button label switches to 'Try It' on step 3 in use-case mode", async () => {
    mockNonAdmin("a0000000-0000-4000-a000-000000000001");

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hi&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    await expect(context.store.get(onboardingNextLabel$)).resolves.toBe(
      "Try It",
    );
  });

  it("eager-init forwards URL connectors and Try It starts checkout while payment is pending", async () => {
    let capturedBody: { selectedConnectors?: string[] } | null = null;
    let checkoutBody: Record<string, unknown> | null = null;
    const agentId = "d0000000-0000-4000-a000-000000000001";

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
      mockApi(onboardingSetupContract.setup, ({ body, respond }) => {
        capturedBody = body as { selectedConnectors?: string[] };
        return respond(200, { agentId });
      }),
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        checkoutBody = body as Record<string, unknown>;
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=trial",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=original&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    // Step 1 Next → eager-init runs setup with the URL connector authorized.
    context.store.set(setZeroWorkspaceName$, "Acme");
    await context.store.set(onboardingStepNext$, context.signal);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody!.selectedConnectors).toStrictEqual(["github"]);
    await expect(context.store.get(onboardingEffectiveStep$)).resolves.toBe(
      "3",
    );

    // After eager-init, the backend has a default agent but keeps onboarding
    // active until Stripe checkout clears onboardingPaymentPending.
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: agentId,
          defaultAgentMetadata: null,
        });
      }),
    );

    // User edits the prompt in the composer and clicks Try It.
    context.store.set(setOnboardingPromptDraft$, "edited prompt");
    await context.store.set(onboardingStepNext$, context.signal);

    expect(checkoutBody).toMatchObject({ tier: "pro", trialDays: 7 });
  });

  it("resolved prompt prefers the edited draft over the URL prompt", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=from-url&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    // Initially draft is seeded from URL → both agree.
    expect(context.store.get(onboardingResolvedPrompt$)).toBe("from-url");

    context.store.set(setOnboardingPromptDraft$, "edited prompt");
    expect(context.store.get(onboardingResolvedPrompt$)).toBe("edited prompt");
  });

  describe("already-onboarded user revisiting via use-case deep link", () => {
    function mockOnboarded(defaultAgentId: string) {
      server.use(
        mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
          return respond(200, {
            needsOnboarding: false,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId,
            defaultAgentMetadata: null,
          });
        }),
      );
    }

    it("does not redirect to home when the URL carries ?prompt= + ?connector=", async () => {
      mockOnboarded("a0000000-0000-4000-a000-000000000099");

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      // No redirect happened — we're still on /onboarding.
      expect(pathname()).toBe("/onboarding");
    });

    it("redirects to home for an onboarded user when no use-case link is present", async () => {
      mockOnboarded("a0000000-0000-4000-a000-000000000099");

      detachedSetupPage({
        context,
        path: "/onboarding",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      // The historical behavior is preserved when there's nothing to try.
      expect(pathname()).toBe("/");
    });

    it("shows the dialog with a single-step flow (step 3 only)", async () => {
      mockOnboarded("a0000000-0000-4000-a000-000000000099");

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      await expect(
        context.store.get(onboardingShowDialog$),
      ).resolves.toBeTruthy();
      await expect(context.store.get(onboardingEffectiveStep$)).resolves.toBe(
        "3",
      );
      await expect(
        context.store.get(onboardingVisibleSteps$),
      ).resolves.toStrictEqual(["3"]);
      await expect(context.store.get(onboardingNextLabel$)).resolves.toBe(
        "Try It",
      );
    });

    it("does not suppress the post-connect permission dialog", async () => {
      mockOnboarded("a0000000-0000-4000-a000-000000000099");

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      // The signal-level flag the view reads to decide whether to silence the
      // per-connector "authorize to agent" dialog. For an already-onboarded
      // user the backend won't bulk-authorize, so the dialog must run.
      await expect(
        context.store.get(onboardingBackendWillAuthorizeConnectors$),
      ).resolves.toBeFalsy();
    });
  });

  describe("admin eager init on step 1 Next", () => {
    function setupAdminMocks() {
      const agentId = "d0000000-0000-4000-a000-000000000099";
      const setupCalls: { selectedConnectors?: string[] }[] = [];
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
        mockApi(onboardingSetupContract.setup, ({ body, respond }) => {
          setupCalls.push(body as { selectedConnectors?: string[] });
          return respond(200, { agentId });
        }),
      );
      return { setupCalls, agentId };
    }

    it("provisions the workspace and advances to the connect step (use-case)", async () => {
      const { setupCalls } = setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      // Setup API was called exactly once at step 1, with the URL connector
      // bulk-authorized.
      expect(setupCalls).toHaveLength(1);
      expect(setupCalls[0]!.selectedConnectors).toStrictEqual(["github"]);
      // We're now on step 3 (the connect-with-composer step).
      await expect(context.store.get(onboardingEffectiveStep$)).resolves.toBe(
        "3",
      );
      // Eager-init flag flipped.
      expect(context.store.get(onboardingEagerInitialized$)).toBeTruthy();
    });

    it("provisions the workspace and advances to the picker (regular flow, no URL connectors)", async () => {
      const { setupCalls } = setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);

      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      expect(setupCalls).toHaveLength(1);
      // No connectors picked yet → backend gets no selectedConnectors.
      expect(setupCalls[0]!.selectedConnectors).toBeUndefined();
      // Step 1 → step 2 (the picker).
      await expect(context.store.get(onboardingEffectiveStep$)).resolves.toBe(
        "2",
      );
    });

    it("keeps the dialog visible after eager init while checkout remains pending", async () => {
      setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      // Post-eager-init the backend reports a default agent while payment is
      // still pending. The dialog must stay visible so the user can start
      // checkout from the remaining step.
      await expect(
        context.store.get(onboardingShowDialog$),
      ).resolves.toBeTruthy();
    });

    it("permission dialog suppression stays on after eager init in use-case mode", async () => {
      setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      // Use-case mode: the URL connectors were bulk-authorized at eager init,
      // and step 3 doesn't let the user pick anything new. Suppression stays
      // on so the post-OAuth permission dialog doesn't pop up redundantly.
      await expect(
        context.store.get(onboardingBackendWillAuthorizeConnectors$),
      ).resolves.toBeTruthy();
    });

    it("permission dialog suppression flips off after eager init in the regular flow", async () => {
      setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      // Regular flow: the user is about to pick brand-new connectors via the
      // picker — those weren't covered by the eager-init bulk authorize, so
      // each Connect must run the permission dialog.
      await expect(
        context.store.get(onboardingBackendWillAuthorizeConnectors$),
      ).resolves.toBeFalsy();
    });

    it("try it on step 3 after eager init starts checkout and does not re-call setup", async () => {
      const { setupCalls } = setupAdminMocks();
      let checkoutBody: Record<string, unknown> | null = null;
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
        mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
          checkoutBody = body as Record<string, unknown>;
          return respond(200, {
            url: "https://checkout.stripe.com/test?mode=trial",
          });
        }),
      );

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      // Step 1 Next → setup runs (call #1).
      await context.store.set(onboardingStepNext$, context.signal);
      expect(setupCalls).toHaveLength(1);

      // Step 3 (Try It) starts checkout and must NOT re-call setup.
      context.store.set(setOnboardingPromptDraft$, "hello");
      await context.store.set(onboardingStepNext$, context.signal);

      expect(setupCalls).toHaveLength(1);
      expect(checkoutBody).toMatchObject({ tier: "pro", trialDays: 7 });
    });
  });

  it("resolved prompt falls back to the URL when the draft is empty (classic deep link)", async () => {
    mockNonAdmin("a0000000-0000-4000-a000-000000000001");

    // Classic deep-link without ?prompt= → draft never seeded.
    detachedSetupPage({
      context,
      path: "/onboarding?connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    // No prompt to forward at all.
    expect(context.store.get(onboardingResolvedPrompt$)).toBeNull();

    // And if a URL prompt is present but the draft was cleared by the user,
    // the draft (empty after trimming) yields to the URL value.
    context.store.set(setOnboardingPromptDraft$, "   ");
    expect(context.store.get(onboardingResolvedPrompt$)).toBeNull();
  });
});
