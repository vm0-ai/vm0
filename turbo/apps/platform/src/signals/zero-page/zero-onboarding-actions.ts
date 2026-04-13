import { command, computed } from "ccstate";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
  zeroOnboardingStep$,
  zeroAgentName$,
  zeroWorkspaceName$,
  zeroSelectedConnectors$,
  setZeroStep$,
  completeZeroOnboarding$,
  completeMemberOnboarding$,
  connectorsFromUrl$,
} from "./zero-onboarding.ts";
import { currentChatAgentDisplayName$ } from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { slackOrgData$ } from "./zero-slack.ts";
import { reloadBillingStatus$ } from "./billing.ts";
import { reloadAgents$ } from "../agent.ts";
import { showAppSkeleton$ } from "../app-skeleton.ts";
import { clerk$ } from "../auth.ts";
import { logger } from "../log.ts";

const L = logger("OnboardingAddToSlack");

// ---------------------------------------------------------------------------
// Admin flag
// ---------------------------------------------------------------------------

export const onboardingIsAdmin$ = zeroNeedsOnboarding$;

// ---------------------------------------------------------------------------
// Step resolution (moved from TSX)
// ---------------------------------------------------------------------------

/**
 * Connectors shown in step 3 — just the current user selection, regardless of
 * role. Members now drive the selection exactly like admins (#9129).
 */
export const onboardingEffectiveConnectors$ = computed((get) => {
  return get(zeroSelectedConnectors$);
});

/**
 * The resolved step after applying role + selection rules:
 *   - Member never sees step 1 (admin-only workspace creation); step 1 → 2.
 *   - Step 2 is skipped when connectors arrive via `?connector=` deep link
 *     (the user already chose); step 2 → 3.
 *   - Step 3 is hidden for both roles when no connector is selected; step 3 → 4.
 */
export const onboardingEffectiveStep$ = computed(async (get) => {
  const step = await get(zeroOnboardingStep$);
  if (!step || step === "done") {
    return undefined;
  }
  const isAdmin = await get(zeroNeedsOnboarding$);
  const fromUrl = get(connectorsFromUrl$);
  if (!isAdmin && step === "1") {
    return fromUrl ? "3" : "2";
  }
  if (fromUrl && step === "2") {
    return "3";
  }
  const selected = get(zeroSelectedConnectors$);
  if (step === "3" && selected.length === 0) {
    return "4";
  }
  return step;
});

/**
 * Steps shown in the progress bar. Admin owns step 1; step 3 only appears
 * when at least one connector is selected. Step 2 (the picker) is omitted
 * when connectors arrived via `?connector=` deep link.
 */
export const onboardingVisibleSteps$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  const selected = get(zeroSelectedConnectors$);
  const hasSelected = selected.length > 0;
  const fromUrl = get(connectorsFromUrl$);
  if (isAdmin) {
    if (fromUrl) {
      return (hasSelected ? ["1", "3", "4"] : ["1", "4"]) as readonly string[];
    }
    return (
      hasSelected ? ["1", "2", "3", "4"] : ["1", "2", "4"]
    ) as readonly string[];
  }
  if (fromUrl) {
    return (hasSelected ? ["3", "4"] : ["4"]) as readonly string[];
  }
  return (hasSelected ? ["2", "3", "4"] : ["2", "4"]) as readonly string[];
});

/** Current step index within visible steps. */
export const onboardingCurrentStepIndex$ = computed(async (get) => {
  const effectiveStep = await get(onboardingEffectiveStep$);
  if (!effectiveStep) {
    return -1;
  }
  const visibleSteps = await get(onboardingVisibleSteps$);
  return visibleSteps.indexOf(effectiveStep);
});

/** Step key for the illustration panel. */
export const onboardingStepKey$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  switch (step) {
    case "1": {
      return "workspace";
    }
    case "2":
    case "3": {
      return "connectors";
    }
    case "4": {
      return "where";
    }
    default: {
      return "workspace";
    }
  }
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Show the back button on every step except the first visible one. */
export const onboardingShowBack$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  if (!step) {
    return false;
  }
  const visibleSteps = await get(onboardingVisibleSteps$);
  return visibleSteps.indexOf(step) > 0;
});

export const onboardingShowNext$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  return step !== "4" && step !== undefined;
});

export const onboardingNextDisabled$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  if (step === "1") {
    return !get(zeroWorkspaceName$).trim();
  }
  return false;
});

export const onboardingStepBack$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const step = await get(onboardingEffectiveStep$);
    const hasSelected = get(zeroSelectedConnectors$).length > 0;
    const fromUrl = get(connectorsFromUrl$);
    switch (step) {
      case "2": {
        set(setZeroStep$, "1");
        break;
      }
      case "3": {
        set(setZeroStep$, fromUrl ? "1" : "2");
        break;
      }
      case "4": {
        if (fromUrl) {
          set(setZeroStep$, hasSelected ? "3" : "1");
        } else {
          set(setZeroStep$, hasSelected ? "3" : "2");
        }
        break;
      }
    }
  },
);

export const onboardingStepNext$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const step = await get(onboardingEffectiveStep$);
    const hasSelected = get(zeroSelectedConnectors$).length > 0;
    const fromUrl = get(connectorsFromUrl$);
    switch (step) {
      case "1": {
        set(setZeroStep$, fromUrl ? (hasSelected ? "3" : "4") : "2");
        break;
      }
      case "2": {
        set(setZeroStep$, hasSelected ? "3" : "4");
        break;
      }
      case "3": {
        set(setZeroStep$, "4");
        break;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Whether onboarding should show at all
// ---------------------------------------------------------------------------

export const onboardingShowDialog$ = computed(async (get) => {
  const needsOnboarding = await get(zeroNeedsOnboarding$);
  const needsMember = await get(zeroNeedsMemberOnboarding$);
  return needsOnboarding || needsMember;
});

// ---------------------------------------------------------------------------
// Derived state for WhereToWorkContent
// ---------------------------------------------------------------------------

/**
 * Display name shown in the "Where to work" step.
 * Admin sees the name they typed; member sees the default agent's display name.
 */
export const onboardingDisplayName$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (isAdmin) {
    return get(zeroAgentName$);
  }
  return await get(currentChatAgentDisplayName$);
});

const completeOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadBillingStatus$);

    const isAdmin = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const agentId = isAdmin
      ? await set(completeZeroOnboarding$, signal)
      : await set(completeMemberOnboarding$, signal);

    set(reloadAgents$);
    return agentId;
  },
);

export const onboardingAddToSlack$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    L.info("[1] addToSlack invoked");
    set(showAppSkeleton$);

    const result = await set(completeOnboarding$, signal);
    L.info("[2] completeOnboarding result", { agentId: result });
    if (!result) {
      L.warn("[2a] no agentId returned, aborting before slack open");
      return;
    }

    // Read admin role straight from Clerk — completeZeroOnboarding$ already
    // refreshed the JWT and reloaded the organization, so the membership
    // list reflects the freshly-created org.
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const activeOrgId = clerk.organization?.id;
    const membership = clerk.user?.organizationMemberships?.find((m) => {
      return m.organization?.id === activeOrgId;
    });
    const isAdmin = membership?.role === "org:admin";
    L.info("[3] clerk admin?", {
      activeOrgId,
      role: membership?.role,
      isAdmin,
    });

    if (isAdmin) {
      const slackData = await get(slackOrgData$);
      signal.throwIfAborted();
      L.info("[4] slackOrgData", {
        isConnected: slackData.isConnected,
        isInstalled: slackData.isInstalled,
        isAdmin: slackData.isAdmin,
        installUrl: slackData.installUrl,
        connectUrl: slackData.connectUrl,
      });
      if (slackData.installUrl) {
        const url = new URL(slackData.installUrl, window.location.origin);
        // Carry ?prompt= through the Slack OAuth state so the DM greeting can
        // reference it once install completes.
        const prompt = get(searchParams$).get("prompt");
        if (prompt) {
          url.searchParams.set("prompt", prompt);
        }
        url.searchParams.set("_t", String(Date.now()));
        const finalUrl = url.toString();
        L.info("[5] window.open about to fire", { url: finalUrl });
        const popup = window.open(finalUrl, "_blank");
        L.info("[6] window.open returned", {
          popupOpened: popup !== null,
          popupClosed: popup?.closed,
        });
      } else {
        L.warn("[4a] installUrl is null — backend says no install URL", {
          isInstalled: slackData.isInstalled,
          isAdmin: slackData.isAdmin,
        });
      }
    } else {
      L.info("[3a] not vm0 admin, skipping slack open");
    }
    L.info("[7] navigating to /works");
    set(detachedNavigateTo$, "/works");
  },
);

export const onboardingContinueWeb$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    const agentId = await set(completeOnboarding$, signal);

    if (!agentId) {
      return;
    }

    // Forward ?prompt= to the chat page so the composer gets pre-filled with
    // the prompt the user arrived with.
    const prompt = get(searchParams$).get("prompt");

    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId: agentId },
      searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
    });
  },
);
