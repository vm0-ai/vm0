import { command, computed } from "ccstate";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
  zeroOnboardingStep$,
  zeroOnboardingStatus$,
  zeroAgentName$,
  zeroWorkspaceName$,
  zeroSelectedConnectors$,
  setZeroStep$,
  completeZeroOnboarding$,
  completeMemberOnboarding$,
} from "./zero-onboarding.ts";
import { currentChatAgentDisplayName$ } from "../agent-chat.ts";
import { allConnectorTypes$ } from "./settings/connectors.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { slackOrgData$ } from "./zero-slack.ts";
import { reloadBillingStatus$ } from "./billing.ts";
import { showAppSkeleton$ } from "../app-skeleton.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

// ---------------------------------------------------------------------------
// Admin flag
// ---------------------------------------------------------------------------

export const onboardingIsAdmin$ = zeroNeedsOnboarding$;

// ---------------------------------------------------------------------------
// Step resolution (moved from TSX)
// ---------------------------------------------------------------------------

const ADMIN_STEPS = ["1", "2", "3", "4"] as const;

/** Connector types the member should see, derived from default agent skills. */
const onboardingMemberConnectors$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (isAdmin) {
    return [] as ConnectorType[];
  }
  const status = await get(zeroOnboardingStatus$);
  const skillUrls = status.defaultAgentSkills ?? [];
  const all = await get(allConnectorTypes$);
  const typeSet = new Set(
    all.map((c) => {
      return c.type;
    }),
  );
  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).filter((type) => {
    const isInAgent = skillUrls.some((url) => {
      return url.endsWith(`/${type}`);
    });
    return isInAgent && typeSet.has(type);
  });
});

/** Connectors shown in step 3: admin's selection vs member's derived list. */
export const onboardingEffectiveConnectors$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (isAdmin) {
    return get(zeroSelectedConnectors$);
  }
  return await get(onboardingMemberConnectors$);
});

/** The resolved step accounting for admin/member logic. */
export const onboardingEffectiveStep$ = computed(async (get) => {
  const step = await get(zeroOnboardingStep$);
  if (!step || step === "done") {
    return undefined;
  }
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (isAdmin) {
    return step;
  }
  const memberConnectors = await get(onboardingMemberConnectors$);
  const hasMemberConnectors = memberConnectors.length > 0;
  if (step === "1" || step === "2" || (step === "3" && !hasMemberConnectors)) {
    return hasMemberConnectors ? "3" : "4";
  }
  return step;
});

/** Steps shown in the progress bar. */
export const onboardingVisibleSteps$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (isAdmin) {
    return ADMIN_STEPS as readonly string[];
  }
  const memberConnectors = await get(onboardingMemberConnectors$);
  return (
    memberConnectors.length > 0 ? ["3", "4"] : ["4"]
  ) as readonly string[];
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

export const onboardingShowBack$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  const isAdmin = await get(zeroNeedsOnboarding$);
  switch (step) {
    case "1": {
      return false;
    }
    case "2": {
      return true;
    }
    case "3": {
      return isAdmin;
    }
    case "4": {
      if (isAdmin) {
        return true;
      }
      const memberConnectors = await get(onboardingMemberConnectors$);
      return memberConnectors.length > 0;
    }
    default: {
      return false;
    }
  }
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
    switch (step) {
      case "2": {
        set(setZeroStep$, "1");
        break;
      }
      case "3": {
        set(setZeroStep$, "2");
        break;
      }
      case "4": {
        set(setZeroStep$, "3");
        break;
      }
    }
  },
);

export const onboardingStepNext$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const step = await get(onboardingEffectiveStep$);
    switch (step) {
      case "1": {
        set(setZeroStep$, "2");
        break;
      }
      case "2": {
        set(setZeroStep$, "3");
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
    return isAdmin
      ? await set(completeZeroOnboarding$, signal)
      : await set(completeMemberOnboarding$, signal);
  },
);

export const onboardingAddToSlack$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    const result = await set(completeOnboarding$, signal);
    if (!result) {
      return;
    }

    const isAdmin = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    if (isAdmin) {
      const slackData = await get(slackOrgData$);
      signal.throwIfAborted();
      if (slackData.isAdmin && slackData.installUrl) {
        const url = new URL(slackData.installUrl, window.location.origin);
        url.searchParams.set("_t", String(Date.now()));
        window.open(url.toString(), "_blank");
      }
    }
    set(detachedNavigateTo$, "/works");
  },
);

export const onboardingContinueWeb$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    const agentId = await set(completeOnboarding$, signal);

    if (!agentId) {
      return;
    }

    set(detachedNavigateTo$, "/agents/:id/chat", {
      pathParams: { id: agentId },
    });
  },
);
