import { command, computed, state } from "ccstate";
import {
  onboardingStatusContract,
  onboardingCompleteContract,
  orgDefaultAgentContract,
  zeroOrgContract,
  zeroUserConnectorsContract,
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
  set(internalReload$, (x) => {
    return x + 1;
  });
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
 * Whether the admin onboarding flow (full org setup) should be shown.
 * Only true when org has no default agent yet — the first admin must set it up.
 */
export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding && !status.hasDefaultAgent;
});

/**
 * Whether the personal onboarding flow (connect tools, choose where to work)
 * should be shown. Applies to both members and invited admins joining an
 * already-set-up org.
 */
export const zeroNeedsMemberOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding && status.hasDefaultAgent;
});

/**
 * Mark member onboarding as complete.
 * Writes to Clerk membership metadata, then reloads onboarding status
 * so the dialog disappears (server reads Clerk API directly, no JWT needed).
 * Returns the default agent ID so callers can pass it to sendNewThreadMessage$.
 */
export const completeMemberOnboarding$ = command(
  async ({ get, set }, _signal: AbortSignal): Promise<string | undefined> => {
    set(internalSaving$, true);
    try {
      const client = get(zeroClient$)(onboardingCompleteContract);
      await client.complete();
      set(internalReload$, (x) => {
        return x + 1;
      });
      const status = await get(zeroOnboardingStatus$);
      return status.defaultAgentId ?? undefined;
    } finally {
      set(internalSaving$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// Onboarding form state
// ---------------------------------------------------------------------------

type ZeroOnboardingStep = "1" | "2" | "3" | "4" | "done";

/** User-driven step override; null means derive from initialOnboardingStep$. */
const userStep$ = state<ZeroOnboardingStep | null>(null);

const initialOnboardingStep$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  if (!status.needsOnboarding) {
    return "done" as const;
  }
  return (status.hasDefaultAgent ? "3" : "1") as ZeroOnboardingStep;
});

const internalAgentName$ = state("Zero");
const internalWorkspaceName$ = state("");
const internalSaving$ = state(false);
const internalSelectedConnectors$ = state<string[]>([]);
const internalOnboardingError$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Exported computed state
// ---------------------------------------------------------------------------

export const zeroOnboardingStep$ = computed(async (get) => {
  const userStep = get(userStep$);
  if (userStep !== null) {
    return userStep;
  }
  return await get(initialOnboardingStep$);
});
export const zeroAgentName$ = computed((get) => {
  return get(internalAgentName$);
});
export const zeroWorkspaceName$ = computed((get) => {
  return get(internalWorkspaceName$);
});
export const zeroSaving$ = computed((get) => {
  return get(internalSaving$);
});
export const zeroSelectedConnectors$ = computed((get) => {
  return get(internalSelectedConnectors$);
});

export const zeroOnboardingError$ = computed((get) => {
  return get(internalOnboardingError$);
});

export const clearZeroOnboardingError$ = command(({ set }) => {
  set(internalOnboardingError$, null);
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setZeroStep$ = command(({ set }, step: ZeroOnboardingStep) => {
  set(userStep$, step);
});

export const setZeroAgentName$ = command(({ set }, name: string) => {
  set(internalAgentName$, name);
});

export const setZeroWorkspaceName$ = command(({ set }, name: string) => {
  set(internalWorkspaceName$, name);
});

export const toggleZeroConnector$ = command(
  ({ set }, connectorValue: string) => {
    set(internalSelectedConnectors$, (prev) => {
      return prev.includes(connectorValue)
        ? prev.filter((s) => {
            return s !== connectorValue;
          })
        : [...prev, connectorValue];
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Reset the onboarding step to null so initialOnboardingStep$ takes over.
 * Call this on page entry to ensure a fresh reactive derivation.
 */
export const resetOnboardingStep$ = command(({ set }) => {
  set(userStep$, null);
});

/**
 * Complete onboarding: create agent via zero agents API and set as default.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    set(internalOnboardingError$, null);

    try {
      const displayName = get(internalAgentName$);
      const workspaceName = get(internalWorkspaceName$);
      const selectedConnectors = get(internalSelectedConnectors$);
      const createClient = get(zeroClient$);

      // Update org name and slug if provided
      if (workspaceName.trim()) {
        const name = workspaceName.trim();
        const baseSlug = name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64);
        const orgClient = createClient(zeroOrgContract);

        // Try slug from name first, fall back to slug+random on conflict
        const slugCandidates = [
          baseSlug,
          `${baseSlug.slice(0, 56)}-${Math.random().toString(36).slice(2, 8)}`,
        ];
        let updated = false;
        for (const slug of slugCandidates) {
          if (slug.length < 3) {
            continue;
          }
          const orgResult = await orgClient.update({
            body: { name, slug, force: true },
          });
          signal.throwIfAborted();
          if (orgResult.status === 200) {
            updated = true;
            break;
          }
          // Only retry on conflict (slug taken); other errors are fatal
          if (orgResult.status !== 409) {
            throw new Error(
              `Failed to update workspace name: ${orgResult.status}`,
            );
          }
        }
        // If both slug candidates failed, update name only
        if (!updated) {
          const orgResult = await orgClient.update({ body: { name } });
          signal.throwIfAborted();
          if (orgResult.status !== 200) {
            throw new Error(
              `Failed to update workspace name: ${orgResult.status}`,
            );
          }
        }
      }

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
        displayName,
        sound: "professional",
        avatarUrl: "preset:0",
      });
      signal.throwIfAborted();

      // Set initial connector permissions for the new agent
      if (selectedConnectors.length > 0) {
        const userConnectorsClient = createClient(zeroUserConnectorsContract);
        await userConnectorsClient.update({
          params: { id: agent.agentId },
          body: { enabledTypes: selectedConnectors },
        });
        signal.throwIfAborted();
      }

      // Set as default agent
      const defaultAgentClient = createClient(orgDefaultAgentContract);
      const result = await defaultAgentClient.setDefaultAgent({
        query: {},
        body: { agentId: agent.agentId },
      });
      signal.throwIfAborted();

      if (result.status !== 200) {
        throw new Error(`Failed to set default agent: ${result.status}`);
      }

      // Mark personal onboarding as done so admin doesn't re-enter member flow
      const completeClient = createClient(onboardingCompleteContract);
      await completeClient.complete();
      signal.throwIfAborted();

      L.debug("Zero onboarding completed", {
        agentId: agent.agentId,
      });

      // Force JWT refresh so updated org metadata is available immediately
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      await clerk.session?.getToken({ skipCache: true });
      signal.throwIfAborted();

      // Reload the Clerk organization object so client-side reads
      // (e.g. org switcher) reflect the updated name immediately.
      await clerk.organization?.reload();
      signal.throwIfAborted();

      set(internalReload$, (x) => {
        return x + 1;
      });

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
 * Initialize onboarding status by eagerly loading it.
 * Called on page setup so onboarding data is ready before onboardGuard$ checks it.
 */
export const initZeroOnboarding$ = command(
  async ({ get }, signal: AbortSignal) => {
    await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
  },
);
