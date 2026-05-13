import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
  connectorsFromUrl$,
  onboardingIsUseCase$,
  onboardingPromptDraft$,
} from "./zero-onboarding.ts";
import { currentChatAgentDisplayName$ } from "../agent-chat.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { rootSignal$ } from "../root-signal.ts";
import { ROUTES } from "../route-paths.ts";
import { slackOrgData$ } from "./zero-slack.ts";

import { reloadBillingStatus$ } from "./billing.ts";
import { reloadAgentById$, reloadAgents$ } from "../agent.ts";
import { reloadPinnedAgents$ } from "./zero-pinned-agents.ts";
import { showAppSkeleton$, startSkeletonCycling$ } from "../app-skeleton.ts";
import { sendNewThreadOptimistically$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { resolveModelFirstUserDefaultSelection } from "./model-default-selection.ts";
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
  const isUseCase = get(onboardingIsUseCase$);
  // Already-onboarded user arriving via a use-case deep link: there is no
  // onboarding to do, but we still want to show step 3 so they can review
  // connectors + tweak the prompt before hitting Try It.
  if ((!step || step === "done") && isUseCase) {
    return "3";
  }
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
  // Use-case mode has no step 4 — stay on step 3 even with an empty
  // selection so the composer + Try It CTA remain visible.
  if (!isUseCase) {
    const selected = get(zeroSelectedConnectors$);
    if (step === "3" && selected.length === 0) {
      return "4";
    }
  }
  return step;
});

/**
 * Steps shown in the progress bar. Admin owns step 1; step 3 only appears
 * when at least one connector is selected. Step 2 (the picker) is omitted
 * when connectors arrived via `?connector=` deep link. Step 4 ("Where would
 * you like to work?") is omitted in "use case" mode — the Try It CTA on
 * step 3 goes straight to web chat.
 */
export const onboardingVisibleSteps$ = computed(async (get) => {
  const isAdmin = await get(zeroNeedsOnboarding$);
  const needsMember = await get(zeroNeedsMemberOnboarding$);
  const selected = get(zeroSelectedConnectors$);
  const hasSelected = selected.length > 0;
  const fromUrl = get(connectorsFromUrl$);
  const isUseCase = get(onboardingIsUseCase$);
  // Already-onboarded user arriving via use-case deep link: collapse the
  // flow to a single step 3 (composer + connectors). No workspace step
  // because the workspace already exists.
  if (isUseCase && !isAdmin && !needsMember) {
    return (hasSelected ? ["3"] : []) as readonly string[];
  }
  if (isAdmin) {
    if (isUseCase) {
      return (hasSelected ? ["1", "3"] : ["1"]) as readonly string[];
    }
    if (fromUrl) {
      return (hasSelected ? ["1", "3", "4"] : ["1", "4"]) as readonly string[];
    }
    return (
      hasSelected ? ["1", "2", "3", "4"] : ["1", "2", "4"]
    ) as readonly string[];
  }
  if (isUseCase) {
    return (hasSelected ? ["3"] : []) as readonly string[];
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

/**
 * True when the running flow will run the onboarding "complete/setup" backend
 * call at finish, which bulk-authorizes selected connectors to the default
 * agent. The post-connect permission dialog can be suppressed in that case;
 * already-onboarded users (use-case revisit) must run the dialog so each new
 * connector is authorized individually.
 */
export const onboardingBackendWillAuthorizeConnectors$ = computed(
  async (get) => {
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    const needsMember = await get(zeroNeedsMemberOnboarding$);
    return needsOnboarding || needsMember;
  },
);

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

/**
 * Label shown on the primary forward button in the footer. "Try It" on the
 * terminal step of a use-case flow signals that clicking finishes onboarding
 * and jumps into the chat; everywhere else it's a plain "Next".
 */
export const onboardingNextLabel$ = computed(async (get) => {
  const step = await get(onboardingEffectiveStep$);
  const isUseCase = get(onboardingIsUseCase$);
  if (isUseCase && step === "3") {
    return "Try It";
  }
  return "Next";
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
  async ({ get, set }, signal: AbortSignal) => {
    const step = await get(onboardingEffectiveStep$);
    signal.throwIfAborted();
    const hasSelected = get(zeroSelectedConnectors$).length > 0;
    const fromUrl = get(connectorsFromUrl$);
    const isUseCase = get(onboardingIsUseCase$);
    switch (step) {
      case "1": {
        if (isUseCase) {
          set(setZeroStep$, "3");
          break;
        }
        set(setZeroStep$, fromUrl ? (hasSelected ? "3" : "4") : "2");
        break;
      }
      case "2": {
        set(setZeroStep$, hasSelected ? "3" : "4");
        break;
      }
      case "3": {
        if (isUseCase) {
          // Try It: create org + default agent, authorize selected connectors,
          // navigate to the new agent's web chat with the edited prompt.
          await set(onboardingContinueWeb$, signal);
          break;
        }
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
  // Already-onboarded users still see the dialog when they arrive via a
  // use-case deep link, so they can review connectors + edit the prompt.
  const isUseCase = get(onboardingIsUseCase$);
  return needsOnboarding || needsMember || isUseCase;
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

export const onboardingShowTelegram$ = computed(() => {
  return true;
});

export const onboardingShowAgentPhone$ = computed((get) => {
  const features = get(featureSwitch$);
  return features[FeatureSwitchKey.AgentPhoneAppUi] ?? false;
});

export const completeOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadBillingStatus$);

    const isAdmin = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const agentId = isAdmin
      ? await set(completeZeroOnboarding$, signal)
      : await set(completeMemberOnboarding$, signal);

    set(reloadAgents$);
    set(reloadAgentById$);
    set(reloadPinnedAgents$);
    return agentId;
  },
);

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

export const onboardingAddToSlack$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        const result = await set(completeOnboarding$, signal);
        if (!result) {
          return;
        }

        const slackData = await get(slackOrgData$);
        signal.throwIfAborted();

        // The backend returns installUrl for admins on a brand-new workspace
        // and connectUrl for everyone else (members, or admins where the
        // workspace app is already installed). Either one continues the
        // onboarding flow in Slack — open whichever the backend offered.
        const targetUrl = slackData.installUrl ?? slackData.connectUrl;
        const prompt = get(onboardingResolvedPrompt$);

        if (targetUrl) {
          const url = new URL(targetUrl, window.location.origin);
          // Carry ?prompt= through the OAuth state so the DM greeting can
          // reference it once install/connect completes.
          if (prompt) {
            url.searchParams.set("prompt", prompt);
          }
          url.searchParams.set("_t", String(Date.now()));
          window.open(url.toString(), "_blank");
        } else {
          L.warn("no slack install or connect URL returned, skipping popup", {
            isInstalled: slackData.isInstalled,
            isAdmin: slackData.isAdmin,
          });
        }

        // Forward the prompt to /works so the page can keep the same context
        // (e.g. re-opening the DM) once the OAuth tab returns.
        set(detachedNavigateTo$, "/works", {
          searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        });
      })(),
    ]);
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

export const onboardingContinueWeb$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        // Already-onboarded users (typical "use-case deep link revisit")
        // skip the setup/complete API — calling /onboarding/complete would
        // overwrite their existing connector authorizations on the default
        // agent. Read defaultAgentId from status and continue.
        const status = await get(zeroOnboardingStatus$);
        signal.throwIfAborted();
        const alreadyOnboarded =
          !status.needsOnboarding && status.defaultAgentId !== null;
        const agentId = alreadyOnboarded
          ? status.defaultAgentId
          : await set(completeOnboarding$, signal);

        if (!agentId) {
          return;
        }

        const prompt = get(onboardingResolvedPrompt$);
        const isUseCase = get(onboardingIsUseCase$);

        // Use-case mode: send the prompt as the first message in a brand-new
        // thread so the user lands inside the running thread instead of an
        // empty composer. sendNewThreadOptimistically$ handles the navigate
        // to `/chats/:threadId`.
        if (isUseCase && prompt && prompt.length > 0) {
          // Drop the onboarding deep-link params from the URL before the
          // optimistic router forwards search params to /chats/:threadId —
          // otherwise the new chat URL still carries ?prompt= + ?connector=.
          const cleaned = new URLSearchParams(get(searchParams$));
          cleaned.delete("prompt");
          cleaned.delete("connector");
          set(updateSearchParams$, cleaned);

          // Resolve a concrete modelSelection so the new thread starts with a
          // real model from the user's preference or workspace model policy.
          // Passing `null` would defer resolution to the backend, but the chat
          // page reads the persisted thread's modelSelection back and would
          // render an empty picker until the next user action.
          const modelSelection = await set(
            resolveOnboardingModelSelection$,
            signal,
          );

          // Use the root signal (not the caller's page signal) so the POST
          // /chat/messages request survives the imminent /onboarding →
          // /chats/:threadId navigation. Aborting the fetch mid-flight would
          // surface as "Chat not found" once the persisted thread fails to
          // resolve.
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

        // Classic deep-link flow: navigate to the agent's empty composer page
        // and forward the prompt so it gets pre-filled.
        set(detachedNavigateTo$, "/agents/:agentId/chat", {
          pathParams: { agentId: agentId },
          searchParams: prompt ? new URLSearchParams({ prompt }) : undefined,
        });
      })(),
    ]);
  },
);

export const onboardingContinueTelegram$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        const agentId = await set(completeOnboarding$, signal);

        if (!agentId) {
          return;
        }

        set(detachedNavigateTo$, ROUTES.settingsTelegram);
      })(),
    ]);
  },
);

export const onboardingContinueAgentPhone$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        const agentId = await set(completeOnboarding$, signal);

        if (!agentId) {
          return;
        }

        set(detachedNavigateTo$, ROUTES.works);
      })(),
    ]);
  },
);
