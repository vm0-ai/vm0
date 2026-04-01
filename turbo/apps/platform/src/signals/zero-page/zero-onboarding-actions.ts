import { command, computed } from "ccstate";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
  zeroOnboardingStep$,
  zeroOnboardingStatus$,
  zeroAgentName$,
  zeroWorkspaceName$,
  zeroSaving$,
  zeroSelectedConnectors$,
  zeroOnboardingError$,
  setZeroStep$,
  completeZeroOnboarding$,
  completeMemberOnboarding$,
  dismissZeroOnboarding$,
  clearZeroOnboardingError$,
} from "./zero-onboarding.ts";
import { agentDisplayName$ } from "./zero-agent-name.ts";
import { sendNewThreadMessage$, startNewZeroSession$ } from "./zero-chat.ts";
import { allConnectorTypes$ } from "./settings/connectors.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { slackOrgData$ } from "./zero-slack.ts";
import { reloadBillingStatus$ } from "./billing.ts";
import { detach, Reason } from "../utils.ts";
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
  return await get(agentDisplayName$);
});

/**
 * Onboarding saving state — re-exported for convenience so WhereToWorkContent
 * can import from a single file.
 */
export const onboardingSaving$ = zeroSaving$;

/**
 * Error to display in the "Where to work" step.
 * Only admin sees errors; member path never surfaces them.
 */
export const onboardingError$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  if (!isAdmin) {
    return null;
  }
  return get(zeroOnboardingError$);
});

// ---------------------------------------------------------------------------
// Action commands for WhereToWorkContent
// ---------------------------------------------------------------------------

/**
 * Complete onboarding and navigate to Slack setup.
 * Admin: create agent → reload billing → open Slack install URL → /works
 * Member: mark complete → /works
 */
export const onboardingAddToSlack$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(clearZeroOnboardingError$);
    const isAdmin = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();

    if (isAdmin) {
      const result = await set(completeZeroOnboarding$, signal);
      if (!result) {
        return;
      }
      set(reloadBillingStatus$);
      set(dismissZeroOnboarding$);

      const slackData = get(slackOrgData$);
      if (slackData?.isAdmin && slackData.installUrl) {
        const url = new URL(slackData.installUrl, window.location.origin);
        url.searchParams.set("_t", String(Date.now()));
        window.open(url.toString(), "_blank");
      }

      set(detachedNavigateTo$, "/works");
    } else {
      await set(completeMemberOnboarding$, signal);
      set(detachedNavigateTo$, "/works");
    }
  },
);

/**
 * Complete onboarding and start a web chat session.
 * Admin: create agent → reload billing → navigate home → send intro message
 * Member: mark complete → navigate home → send intro message
 */
export const onboardingContinueWeb$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(clearZeroOnboardingError$);
    const isAdmin = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();

    if (isAdmin) {
      const agentId = await set(completeZeroOnboarding$, signal);
      if (!agentId) {
        return;
      }
      set(reloadBillingStatus$);
      set(detachedNavigateTo$, "/");
      set(startNewZeroSession$);
      detach(
        set(
          sendNewThreadMessage$,
          agentId,
          "Who are you and what can you do?",
          undefined,
          signal,
        ),
        Reason.DomCallback,
      );
      set(dismissZeroOnboarding$);
    } else {
      const agentId = await set(completeMemberOnboarding$, signal);
      if (!agentId) {
        return;
      }
      set(detachedNavigateTo$, "/");
      set(startNewZeroSession$);
      detach(
        set(
          sendNewThreadMessage$,
          agentId,
          "Who are you and what can you do?",
          undefined,
          signal,
        ),
        Reason.DomCallback,
      );
    }
  },
);
