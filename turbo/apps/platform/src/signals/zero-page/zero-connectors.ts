import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { zeroChatAgentName$ } from "./zero-nav.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import type { AgentDetail } from "./agent-types.ts";

const L = logger("ZeroConnectors");

// ---------------------------------------------------------------------------
// Agent name resolution
// ---------------------------------------------------------------------------

const zeroAgentName$ = computed(async (get) => {
  const chatAgentName = get(zeroChatAgentName$);
  if (chatAgentName !== null) {
    return chatAgentName;
  }
  return await get(defaultAgentName$);
});

const internalComposeReload$ = state(0);

/** Bump to force `zeroAgent$` to re-fetch from the API. */
export const reloadZeroCompose$ = command(({ set }) => {
  set(internalComposeReload$, (x) => x + 1);
});

const zeroAgent$ = computed(async (get) => {
  get(internalComposeReload$);
  const agentName = await get(zeroAgentName$);
  if (!agentName) {
    return null;
  }

  const fetchFn = get(fetch$);
  const resp = await fetchFn(
    `/api/zero/agents/${encodeURIComponent(agentName)}`,
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch agent: ${resp.statusText}`);
  }
  return (await resp.json()) as AgentDetail;
});

// ---------------------------------------------------------------------------
// Connectors list: derived from agent response, synced via agents API
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);

// null = not initialized (fallback to seeded), string[] = user's local draft
const internalAddedConnectors$ = state<string[] | null>(null);

/** Connectors from agent response (server already filters out seed skills). */
const seededConnectors$ = computed(async (get) => {
  const agent = await get(zeroAgent$);
  return agent?.connectors ?? [];
});

/** Added connectors: local draft takes precedence, otherwise seeded from agent. */
export const zeroAddedConnectors$ = computed(async (get) => {
  const local = get(internalAddedConnectors$);
  if (local !== null) {
    return local;
  }
  return await get(seededConnectors$);
});

/** Add a connector (local only, no compose job). */
export const addZeroConnector$ = command(async ({ get, set }, name: string) => {
  if (get(internalAddedConnectors$) === null) {
    set(internalAddedConnectors$, await get(seededConnectors$));
  }
  set(internalAddedConnectors$, (prev) => [...(prev ?? []), name]);
});

/** Save connector changes: trigger compose job and wait for completion. */
export const saveZeroConnectors$ = command(async ({ get, set }) => {
  set(internalSaving$, true);
  try {
    const newConnectors = get(internalAddedConnectors$) ?? [];
    await set(syncConnectorsToCompose$, newConnectors);
    // Reset to null so seeded picks up the new agent state
    set(internalAddedConnectors$, null);
    toast.success("Connectors saved");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to save connectors:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to save connectors",
    );
  } finally {
    set(internalSaving$, false);
  }
});

/** Sync the connectors list via zero agents API. */
const syncConnectorsToCompose$ = command(
  async ({ get, set }, connectorValues: string[]) => {
    const agent = await get(zeroAgent$);
    if (!agent) {
      throw new Error("No agent available");
    }

    const fetchFn = get(fetch$);

    const resp = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(agent.name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: connectorValues }),
      },
    );

    if (!resp.ok) {
      const errorData = (await resp.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Save failed: ${resp.statusText}`,
      );
    }

    await set(reloadOnboardingStatus$);
    set(internalComposeReload$, (x) => x + 1);
  },
);
