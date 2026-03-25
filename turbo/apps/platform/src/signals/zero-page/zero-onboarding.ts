import { command, computed, state } from "ccstate";
import {
  onboardingStatusContract,
  onboardingCompleteContract,
  orgDefaultAgentContract,
} from "@vm0/core";
import { clerk$ } from "../auth.ts";
import { zeroClient$ } from "../api-client.ts";
import { createOrgModelProvider$ } from "../external/org-model-providers.ts";
import { createZeroAgent } from "./create-zero-agent.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ZeroOnboarding");

// ---------------------------------------------------------------------------
// Onboarding status (from API)
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

/** Trigger a refresh of the onboarding status from the API. */
export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => x + 1);
});

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);
  const client = get(zeroClient$)(onboardingStatusContract);
  const result = await client.getStatus();
  if (result.status !== 200) {
    throw new Error(`Failed to fetch onboarding status: ${result.status}`);
  }
  return result.body;
});

/**
 * Whether the admin onboarding flow should be shown.
 * Only true for admins when org setup is incomplete (no model provider or agent).
 */
export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.isAdmin && status.needsOnboarding;
});

/**
 * Whether a member (non-admin) needs to see the welcome screen.
 * True when: org is set up (has default agent), user is not admin,
 * and the API says needsOnboarding (Clerk membership metadata).
 */
export const zeroNeedsMemberOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return !status.isAdmin && status.needsOnboarding;
});

/**
 * Mark member onboarding as complete.
 * Writes to Clerk membership metadata, then reloads onboarding status
 * so the dialog disappears (server reads Clerk API directly, no JWT needed).
 */
export const completeMemberOnboarding$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    set(internalSaving$, true);
    try {
      const client = get(zeroClient$)(onboardingCompleteContract);
      await client.complete();
      set(internalReload$, (x) => x + 1);
    } finally {
      set(internalSaving$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// Member welcome step state
// ---------------------------------------------------------------------------

type MemberWelcomeStep = "welcome" | "connectors" | "where";

const internalMemberWelcomeStep$ = state<MemberWelcomeStep>("welcome");

export const memberWelcomeStep$ = computed((get) =>
  get(internalMemberWelcomeStep$),
);

export const setMemberWelcomeStep$ = command(
  ({ set }, step: MemberWelcomeStep) => {
    set(internalMemberWelcomeStep$, step);
  },
);

// ---------------------------------------------------------------------------
// Onboarding form state
// ---------------------------------------------------------------------------

type ZeroOnboardingStep = "1" | "3" | "4" | "done";

const internalStep$ = state<ZeroOnboardingStep>("1");
const internalAgentName$ = state("Zero");
const internalSaving$ = state(false);
const internalSelectedConnectors$ = state<string[]>([]);
const internalOnboardingError$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Exported computed state
// ---------------------------------------------------------------------------

export const zeroOnboardingStep$ = computed((get) => get(internalStep$));
export const zeroAgentName$ = computed((get) => get(internalAgentName$));
export const zeroSaving$ = computed((get) => get(internalSaving$));
export const zeroSelectedConnectors$ = computed((get) =>
  get(internalSelectedConnectors$),
);

export const zeroOnboardingError$ = computed((get) =>
  get(internalOnboardingError$),
);

export const clearZeroOnboardingError$ = command(({ set }) => {
  set(internalOnboardingError$, null);
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setZeroStep$ = command(({ set }, step: ZeroOnboardingStep) => {
  set(internalStep$, step);
});

export const setZeroAgentName$ = command(({ set }, name: string) => {
  set(internalAgentName$, name);
});

export const toggleZeroConnector$ = command(
  ({ set }, connectorValue: string) => {
    set(internalSelectedConnectors$, (prev) =>
      prev.includes(connectorValue)
        ? prev.filter((s) => s !== connectorValue)
        : [...prev, connectorValue],
    );
  },
);

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize onboarding step based on current status.
 * Skips steps that are already completed.
 */
export const initZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();

    if (!status.needsOnboarding) {
      set(internalStep$, "done");
      return;
    }

    // Always start from step 1 when onboarding is needed
    set(internalStep$, "1");
  },
);

/**
 * Complete onboarding: create agent via zero agents API and set as default.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    set(internalOnboardingError$, null);

    try {
      const displayName = get(internalAgentName$);
      const selectedConnectors = get(internalSelectedConnectors$);
      const createClient = get(zeroClient$);

      // Auto-initialize vm0 model provider with default model
      await set(
        createOrgModelProvider$,
        {
          type: "vm0",
          selectedModel: "claude-sonnet-4.6",
        },
        signal,
      );
      signal.throwIfAborted();

      // Create agent and upload instructions (server injects seed skills)
      const agent = await createZeroAgent(createClient, {
        connectors: selectedConnectors,
        displayName,
        sound: "professional",
      });
      signal.throwIfAborted();

      // Set as default agent
      const defaultAgentClient = createClient(orgDefaultAgentContract);
      const result = await defaultAgentClient.setDefaultAgent({
        body: { agentId: agent.agentId },
      });
      signal.throwIfAborted();

      if (result.status !== 200) {
        throw new Error(`Failed to set default agent: ${result.status}`);
      }

      L.debug("Zero onboarding completed", {
        agentId: agent.agentId,
      });

      // Force JWT refresh so updated org metadata is available immediately
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      await clerk.session?.getToken({ skipCache: true });
      signal.throwIfAborted();

      // Reload status (caller dismisses via dismissZeroOnboarding$)
      set(internalReload$, (x) => x + 1);

      return agent.agentId;
    } catch (error) {
      throwIfAbort(error);
      const message =
        error instanceof Error ? error.message : "Failed to complete setup";
      L.error("Failed to complete onboarding:", error);
      set(internalOnboardingError$, message);
      return undefined;
    } finally {
      set(internalSaving$, false);
    }
  },
);

/**
 * Dismiss the admin onboarding dialog.
 * Separated from completeZeroOnboarding$ so callers can control when the
 * dialog disappears (e.g. after a chat thread is initiated).
 */
export const dismissZeroOnboarding$ = command(({ set }) => {
  set(internalStep$, "done");
});
