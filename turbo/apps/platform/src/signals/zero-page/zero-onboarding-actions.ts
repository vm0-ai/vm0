import { command, computed } from "ccstate";
import {
  zeroNeedsOnboarding$,
  zeroAgentName$,
  zeroSaving$,
  zeroOnboardingError$,
  completeZeroOnboarding$,
  completeMemberOnboarding$,
  dismissZeroOnboarding$,
  clearZeroOnboardingError$,
} from "./zero-onboarding.ts";
import { agentDisplayName$ } from "./zero-agent-name.ts";
import { sendNewThreadMessage$, startNewZeroSession$ } from "./zero-chat.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { slackOrgData$ } from "./zero-slack.ts";
import { reloadBillingStatus$ } from "./billing.ts";
import { detach, Reason } from "../utils.ts";

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
