import { command, computed, state } from "ccstate";
import {
  type ZeroAgentResponse,
  onboardingStatusResponseSchema,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { clerk$ } from "../auth.ts";
import { createOrgModelProvider$ } from "../external/org-model-providers.ts";
import { SEED_INSTRUCTIONS, SEED_SKILLS } from "../../data/the-seed.ts";
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
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/zero/onboarding/status");
  if (!resp.ok) {
    throw new Error(`Failed to fetch onboarding status: ${resp.status}`);
  }
  return onboardingStatusResponseSchema.parse(await resp.json());
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
export const completeMemberOnboarding$ = command(async ({ get, set }) => {
  set(internalSaving$, true);
  try {
    const fetchFn = get(fetch$);
    await fetchFn("/api/zero/onboarding/complete", { method: "POST" });
    set(internalReload$, (x) => x + 1);
  } finally {
    set(internalSaving$, false);
  }
});

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
      const fetchFn = get(fetch$);

      // Auto-initialize vm0 model provider with default model
      await set(createOrgModelProvider$, {
        type: "vm0",
        selectedModel: "claude-sonnet-4.6",
      });
      signal.throwIfAborted();

      // Merge seed skills with user-selected skills (deduplicated)
      const allConnectors = [
        ...new Set([...SEED_SKILLS, ...selectedConnectors]),
      ];

      // Create agent via zero agents API
      const createResp = await fetchFn("/api/zero/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectors: allConnectors,
          displayName,
          sound: "professional",
        }),
      });
      signal.throwIfAborted();

      if (!createResp.ok) {
        const errorData = (await createResp.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          errorData?.error?.message ??
            `Failed to create agent: ${createResp.statusText}`,
        );
      }

      const agent = (await createResp.json()) as ZeroAgentResponse;
      signal.throwIfAborted();

      // Upload instructions via zero agents API
      const instrResp = await fetchFn(
        `/api/zero/agents/${encodeURIComponent(agent.name)}/instructions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: SEED_INSTRUCTIONS }),
        },
      );
      signal.throwIfAborted();

      if (!instrResp.ok) {
        const errorData = (await instrResp.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          errorData?.error?.message ??
            `Failed to upload instructions: ${instrResp.statusText}`,
        );
      }

      // Set as default agent
      const defaultResp = await fetchFn("/api/zero/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: agent.agentComposeId,
        }),
      });
      signal.throwIfAborted();

      if (!defaultResp.ok) {
        throw new Error(`Failed to set default agent: ${defaultResp.status}`);
      }

      L.debug("Zero onboarding completed", {
        agentName: agent.name,
        composeId: agent.agentComposeId,
      });

      // Force JWT refresh so updated org metadata is available immediately
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      await clerk.session?.getToken({ skipCache: true });
      signal.throwIfAborted();

      // Reload status (caller dismisses via dismissZeroOnboarding$)
      set(internalReload$, (x) => x + 1);

      return agent.agentComposeId;
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
