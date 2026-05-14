import { command, computed } from "ccstate";
import {
  zeroNeedsOnboarding$,
  zeroOnboardingStep$,
  zeroOnboardingStatus$,
  zeroWorkspaceName$,
  zeroSelectedConnectors$,
  setZeroStep$,
  completeZeroOnboarding$,
  onboardingIsUseCase$,
  onboardingPromptDraft$,
  onboardingEagerInitialized$,
  markEagerInitialized$,
} from "./zero-onboarding.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { rootSignal$ } from "../root-signal.ts";

import { reloadBillingStatus$ } from "./billing.ts";
import { reloadAgentById$, reloadAgents$ } from "../agent.ts";
import { reloadPinnedAgents$ } from "./zero-pinned-agents.ts";
import { showAppSkeleton$, startSkeletonCycling$ } from "../app-skeleton.ts";
import { sendNewThreadOptimistically$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { resolveModelFirstUserDefaultSelection } from "./model-default-selection.ts";

// ---------------------------------------------------------------------------
// Admin flag
// ---------------------------------------------------------------------------

/**
 * Whether the current user should be treated as the org admin throughout the
 * onboarding session. Sticky: once we've eagerly provisioned the workspace
 * at step 1, `zeroNeedsOnboarding$` flips false on the server, but the user
 * is still the admin completing the rest of the steps — keep the flag true
 * so view-layer step decisions stay consistent.
 */
export const onboardingIsAdmin$ = computed(async (get) => {
  if (get(onboardingEagerInitialized$)) {
    return true;
  }
  return await get(zeroNeedsOnboarding$);
});

// ---------------------------------------------------------------------------
// Step resolution
// ---------------------------------------------------------------------------

/** Connectors shown in the connect step — the current user selection. */
export const onboardingEffectiveConnectors$ = computed((get) => {
  return get(zeroSelectedConnectors$);
});

/**
 * The resolved step. Onboarding is admin workspace setup (step 1 → step 2).
 * A use-case deep link (`?prompt=&connector=`) collapses the flow to step 3,
 * where the user reviews connectors + edits the prompt before "Try It".
 */
export const onboardingEffectiveStep$ = computed(async (get) => {
  const step = await get(zeroOnboardingStep$);
  const isUseCase = get(onboardingIsUseCase$);
  if ((!step || step === "done") && isUseCase) {
    return "3";
  }
  if (!step || step === "done") {
    return undefined;
  }
  return step;
});

/**
 * Steps shown in the progress bar. The regular admin flow is step 1
 * (workspace) + step 2 (connectors). A use-case deep link collapses to step 3
 * (plus step 1 when the admin still has to create the workspace).
 */
export const onboardingVisibleSteps$ = computed(async (get) => {
  const isAdmin = await get(onboardingIsAdmin$);
  const isUseCase = get(onboardingIsUseCase$);
  if (isUseCase) {
    return (isAdmin ? ["1", "3"] : ["3"]) as readonly string[];
  }
  return (isAdmin ? ["1", "2"] : []) as readonly string[];
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
    case "2":
    case "3": {
      return "connectors";
    }
    default: {
      return "workspace";
    }
  }
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * True when the backend already has (or will run) bulk-authorize for the
 * connectors the user is about to Connect — i.e. when the post-connect
 * permission dialog is redundant and should be suppressed.
 *
 * - Eager-init admin in use-case mode: the URL connectors were bulk-authorized
 *   at step 1 — suppress.
 * - Eager-init admin in the regular flow: step 2's picker can add connectors
 *   the eager-init call didn't cover; let the dialog run per connector.
 * - Pre-eager admins: setup will bulk-authorize at finish — suppress.
 * - Already-onboarded users (use-case revisit): no bulk-authorize is coming;
 *   let the dialog run.
 */
export const onboardingBackendWillAuthorizeConnectors$ = computed(
  async (get) => {
    if (get(onboardingEagerInitialized$)) {
      return get(onboardingIsUseCase$);
    }
    return await get(zeroNeedsOnboarding$);
  },
);

export const onboardingShowNext$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  return step !== undefined;
});

export const onboardingNextDisabled$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  if (step === "1") {
    return !get(zeroWorkspaceName$).trim();
  }
  return false;
});

/**
 * Label on the primary forward button. "Try It" finishes a use-case flow,
 * "Get Started" finishes the regular admin flow, "Next" advances step 1.
 */
export const onboardingNextLabel$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  const isUseCase = get(onboardingIsUseCase$);
  if (isUseCase && step === "3") {
    return "Try It";
  }
  if (step === "2") {
    return "Get Started";
  }
  return "Next";
});

export const onboardingStepNext$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const step = await get(onboardingEffectiveStep$);
    signal.throwIfAborted();
    const isUseCase = get(onboardingIsUseCase$);
    switch (step) {
      case "1": {
        // Eagerly provision the workspace + default agent so onboarding is
        // effectively done — refreshing or leaving the (skippable) step 2
        // won't drop the user back into onboarding.
        if (!get(onboardingEagerInitialized$)) {
          await set(completeZeroOnboarding$, signal);
          signal.throwIfAborted();
          set(markEagerInitialized$);
          set(reloadBillingStatus$);
          set(reloadAgents$);
          set(reloadAgentById$);
          set(reloadPinnedAgents$);
        }
        set(setZeroStep$, isUseCase ? "3" : "2");
        break;
      }
      case "2":
      case "3": {
        // Step 2 (regular admin) and step 3 (use-case "Try It") both finish
        // onboarding by continuing into the web chat.
        await set(onboardingContinueWeb$, signal);
        break;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Whether onboarding should show at all
// ---------------------------------------------------------------------------

export const onboardingShowDialog$ = computed(async (get) => {
  const isAdmin = await get(onboardingIsAdmin$);
  const isUseCase = get(onboardingIsUseCase$);
  return isAdmin || isUseCase;
});

// ---------------------------------------------------------------------------
// Finishing onboarding
// ---------------------------------------------------------------------------

/**
 * Resolve the prompt to carry forward when finishing onboarding. The editable
 * composer (use-case mode) wins over the raw `?prompt=` URL param; falling
 * back to the URL keeps the historical behavior intact when the composer
 * isn't shown.
 */
export const onboardingResolvedPrompt$ = computed((get) => {
  const draft = get(onboardingPromptDraft$).trim();
  if (draft.length > 0) {
    return draft;
  }
  return get(searchParams$).get("prompt");
});

/**
 * Re-run setup so the connectors picked in the (skippable) step 2 are
 * authorized to the default agent. Eager-init already created the agent;
 * setup is idempotent on the agent and upserts the connectors.
 */
const authorizeStep2Connectors$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(reloadBillingStatus$);
    const agentId = await set(completeZeroOnboarding$, signal);
    signal.throwIfAborted();
    set(reloadAgents$);
    set(reloadAgentById$);
    set(reloadPinnedAgents$);
    return agentId;
  },
);

/**
 * Resolve a concrete model selection for a brand-new chat thread started
 * from onboarding. Mirrors the regular agent chat landing page's default
 * selection, so use-case threads start with the same model the user would
 * otherwise see in the composer picker.
 */
const resolveOnboardingModelSelection$ = command(
  async ({ get }, signal: AbortSignal) => {
    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    return resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
    });
  },
);

const onboardingContinueWeb$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        const isUseCase = get(onboardingIsUseCase$);
        const eagerInitialized = get(onboardingEagerInitialized$);
        const selectedConnectors = get(zeroSelectedConnectors$);

        // Regular admin finishing step 2 with connectors picked: re-run setup
        // to authorize them to the default agent. Use-case flows already
        // authorized their connectors (step 1 eager-init for the URL
        // connectors, plus the per-connector permission dialog in step 3), so
        // just resolve the default agent from status.
        let agentId: string | null | undefined;
        if (eagerInitialized && !isUseCase && selectedConnectors.length > 0) {
          agentId = await set(authorizeStep2Connectors$, signal);
        } else {
          const status = await get(zeroOnboardingStatus$);
          signal.throwIfAborted();
          agentId = status.defaultAgentId;
        }

        if (!agentId) {
          // Surfacing via throw lets `useLoadableSet` consumers render the
          // error UI instead of leaving the user stuck on the skeleton.
          throw new Error(
            "Onboarding could not resolve a default agent. Please retry.",
          );
        }

        const prompt = get(onboardingResolvedPrompt$);

        // Use-case mode: send the prompt as the first message in a brand-new
        // thread so the user lands inside the running thread instead of an
        // empty composer. sendNewThreadOptimistically$ handles the navigate
        // to `/chats/:threadId`.
        if (isUseCase && prompt && prompt.length > 0) {
          // Drop the onboarding deep-link params from the URL before the
          // optimistic router forwards search params to /chats/:threadId.
          const cleaned = new URLSearchParams(get(searchParams$));
          cleaned.delete("prompt");
          cleaned.delete("connector");
          set(updateSearchParams$, cleaned);

          // Resolve a concrete modelSelection so the new thread starts with a
          // real model from the user's preference or workspace model policy.
          const modelSelection = await set(
            resolveOnboardingModelSelection$,
            signal,
          );

          // Use the root signal (not the caller's page signal) so the POST
          // /chat/messages request survives the imminent /onboarding →
          // /chats/:threadId navigation.
          const rootSignal = get(rootSignal$);
          await set(
            sendNewThreadOptimistically$,
            {
              agentId: agentId,
              prompt,
              modelSelection,
              goal: false,
            },
            rootSignal,
          );
          return;
        }

        // Regular flow: navigate to the agent's chat page and forward the
        // prompt so it gets pre-filled.
        set(detachedNavigateTo$, "/agents/:agentId/chat", {
          pathParams: { agentId: agentId },
          searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        });
      })(),
    ]);
  },
);
