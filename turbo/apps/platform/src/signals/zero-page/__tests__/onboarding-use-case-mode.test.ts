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
  setZeroStep$,
  setZeroWorkspaceName$,
  zeroSelectedConnectors$,
} from "../zero-onboarding.ts";
import {
  onboardingBackendWillAuthorizeConnectors$,
  onboardingEffectiveStep$,
  onboardingNextLabel$,
  onboardingResolvedPrompt$,
  onboardingShowBack$,
  onboardingShowDialog$,
  onboardingStepNext$,
  onboardingVisibleSteps$,
} from "../zero-onboarding-actions.ts";
import { pathname, search } from "../../location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";

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

function mockMemberOnboarding(defaultAgentId: string) {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
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

  it("does not enter use-case mode when only ?prompt= is present", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    expect(context.store.get(onboardingIsUseCase$)).toBeFalsy();
    expect(context.store.get(onboardingPromptDraft$)).toBe("");
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

  it("admin visible steps drop step 4 in use-case mode", async () => {
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

  it("member visible steps reduce to just step 3 in use-case mode", async () => {
    mockMemberOnboarding("a0000000-0000-4000-a000-000000000001");

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hi&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const visible = await context.store.get(onboardingVisibleSteps$);
    expect(visible).toStrictEqual(["3"]);
  });

  it("admin visible steps keep step 4 outside use-case mode", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    const visible = await context.store.get(onboardingVisibleSteps$);
    // No use-case → classic deep-link flow keeps step 4
    expect(visible).toStrictEqual(["1", "3", "4"]);
  });

  it("button label switches to 'Try It' on step 3 in use-case mode", async () => {
    mockMemberOnboarding("a0000000-0000-4000-a000-000000000001");

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

  it("try it on step 3 in use-case mode triggers the setup API with the selected connectors", async () => {
    let capturedBody: { selectedConnectors?: string[] } | null = null;
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
    );

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=original&connector=github",
      withoutRender: true,
    });

    await context.store.set(setupOnboardingPage$, context.signal);

    // Advance from step 1 (workspace name) to step 3, simulating the user
    // filling in a workspace name and clicking Next.
    context.store.set(setZeroWorkspaceName$, "Acme");
    context.store.set(setZeroStep$, "3");
    await expect(context.store.get(onboardingEffectiveStep$)).resolves.toBe(
      "3",
    );

    // User edits the prompt in the composer and clicks Try It.
    context.store.set(setOnboardingPromptDraft$, "edited prompt");
    await context.store.set(onboardingStepNext$, context.signal);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody!.selectedConnectors).toStrictEqual(["github"]);
    // The onboarding deep-link params must be cleared before the optimistic
    // router forwards search params to /chats/:threadId — otherwise the new
    // chat URL still carries ?prompt= + ?connector=.
    const remaining = new URLSearchParams(search());
    expect(remaining.get("prompt")).toBeNull();
    expect(remaining.get("connector")).toBeNull();
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

    it("hides the Back button after eager init", async () => {
      setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      await expect(context.store.get(onboardingShowBack$)).resolves.toBeFalsy();
    });

    it("keeps the dialog visible after the server flips needsOnboarding false", async () => {
      setupAdminMocks();

      detachedSetupPage({
        context,
        path: "/onboarding?prompt=hi&connector=github",
        withoutRender: true,
      });

      await context.store.set(setupOnboardingPage$, context.signal);
      context.store.set(setZeroWorkspaceName$, "Acme");
      await context.store.set(onboardingStepNext$, context.signal);

      // Post-eager-init `zeroNeedsOnboarding$` will reload to false because
      // the backend now reports the user as onboarded. The dialog must still
      // be shown so the user can finish the remaining step.
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

    it("try it on step 3 after eager init does not re-call setup", async () => {
      const { setupCalls, agentId } = setupAdminMocks();
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

      // After eager-init the backend reports needsOnboarding=false. Override
      // the mock so continueWeb$ reads the new state when polling status.
      server.use(
        mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
          return respond(200, {
            needsOnboarding: false,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: agentId,
            defaultAgentMetadata: null,
          });
        }),
      );

      // Step 3 (Try It) → must NOT re-call setup.
      context.store.set(setOnboardingPromptDraft$, "hello");
      await context.store.set(onboardingStepNext$, context.signal);

      expect(setupCalls).toHaveLength(1);
    });
  });

  it("resolved prompt falls back to the URL when the draft is empty (classic deep link)", async () => {
    mockMemberOnboarding("a0000000-0000-4000-a000-000000000001");

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
