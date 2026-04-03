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
import { logger } from "../log.ts";
import { accept } from "../../lib/accept.ts";

const L = logger("ZeroOnboarding");

const internalReload$ = state(0);

export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => {
    return x + 1;
  });
});

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);

  const client = get(zeroClient$)(onboardingStatusContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding && !status.hasDefaultAgent;
});

export const zeroNeedsMemberOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding && status.hasDefaultAgent;
});

export const completeMemberOnboarding$ = command(
  async ({ get, set }, _signal: AbortSignal): Promise<string | undefined> => {
    const client = get(zeroClient$)(onboardingCompleteContract);
    await accept(client.complete(), [200]);
    set(internalReload$, (x) => {
      return x + 1;
    });
    const status = await get(zeroOnboardingStatus$);
    return status.defaultAgentId ?? undefined;
  },
);

type ZeroOnboardingStep = "1" | "2" | "3" | "4" | "done";

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

const internalSelectedConnectors$ = state<string[]>([]);

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

export const zeroSelectedConnectors$ = computed((get) => {
  return get(internalSelectedConnectors$);
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

const internalConnectorSearch$ = state("");

export const connectorSearch$ = computed((get) => {
  return get(internalConnectorSearch$);
});

export const setConnectorSearch$ = command(({ set }, value: string) => {
  set(internalConnectorSearch$, value);
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
    const displayName = get(internalAgentName$);
    const workspaceName = get(internalWorkspaceName$);
    const selectedConnectors = get(internalSelectedConnectors$);
    const createClient = get(zeroClient$);

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
        const orgResult = await accept(
          orgClient.update({ body: { name, slug, force: true } }),
          [200, 409],
        );
        signal.throwIfAborted();
        if (orgResult.status === 200) {
          updated = true;
          break;
        }
        // status === 409, try next slug
      }
      // If both slug candidates failed, update name only
      if (!updated) {
        await accept(orgClient.update({ body: { name } }), [200]);
        signal.throwIfAborted();
      }
    }

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
      await accept(
        userConnectorsClient.update({
          params: { id: agent.agentId },
          body: { enabledTypes: selectedConnectors },
        }),
        [200],
      );
      signal.throwIfAborted();
    }

    // Set as default agent
    const defaultAgentClient = createClient(orgDefaultAgentContract);
    await accept(
      defaultAgentClient.setDefaultAgent({
        query: {},
        body: { agentId: agent.agentId },
      }),
      [200],
    );
    signal.throwIfAborted();

    // Mark personal onboarding as done so admin doesn't re-enter member flow
    const completeClient = createClient(onboardingCompleteContract);
    await accept(completeClient.complete(), [200]);
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
