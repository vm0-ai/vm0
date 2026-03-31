import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract, zeroUserConnectorsContract } from "@vm0/core";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentAgentId$ } from "./agent.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";

const L = logger("ZeroConnectors");

// ---------------------------------------------------------------------------
// Agent name resolution
// ---------------------------------------------------------------------------

const zeroAgentId$ = computed(async (get) => {
  const agentId = get(currentAgentId$);
  if (agentId !== null) {
    return agentId;
  }
  return await get(defaultAgentId$);
});

const internalComposeReload$ = state(0);

const zeroAgent$ = computed(async (get) => {
  get(internalComposeReload$);
  const agentId = await get(zeroAgentId$);
  if (!agentId) {
    return null;
  }

  const client = get(zeroClient$)(zeroAgentsByIdContract);
  const result = await client.get({ params: { id: agentId } });
  if (result.status !== 200) {
    throw new Error(`Failed to fetch agent: ${result.status}`);
  }
  return result.body;
});

// ---------------------------------------------------------------------------
// Connectors list: derived from agent response, synced via agents API
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);

// Local draft tagged with the agent it belongs to; discarded on agent switch.
const internalAddedConnectors$ = state<{
  agentId: string;
  connectors: string[];
} | null>(null);

/** User connector permissions for this agent from the user-connectors API. */
const seededConnectors$ = computed(async (get) => {
  const agent = await get(zeroAgent$);
  if (!agent) {
    return [];
  }
  const client = get(zeroClient$)(zeroUserConnectorsContract);
  const result = await client.get({ params: { id: agent.agentId } });
  if (result.status !== 200) {
    return [];
  }
  return result.body.enabledTypes;
});

/** Added connectors: local draft takes precedence, otherwise seeded from agent. */
export const zeroAddedConnectors$ = computed(async (get) => {
  const agentId = await get(zeroAgentId$);
  const local = get(internalAddedConnectors$);
  if (local !== null && local.agentId === agentId) {
    return local.connectors;
  }
  return await get(seededConnectors$);
});

/** Add a connector (local only, no compose job). */
export const addZeroConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    const agentId = await get(zeroAgentId$);
    const local = get(internalAddedConnectors$);
    const base =
      local !== null && local.agentId === agentId
        ? local.connectors
        : await get(seededConnectors$);
    set(internalAddedConnectors$, {
      agentId: agentId ?? "",
      connectors: [...base, name],
    });
  },
);

/** Remove a connector (local only, no compose job). */
export const removeZeroConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    const agentId = await get(zeroAgentId$);
    const local = get(internalAddedConnectors$);
    const base =
      local !== null && local.agentId === agentId
        ? local.connectors
        : await get(seededConnectors$);
    set(internalAddedConnectors$, {
      agentId: agentId ?? "",
      connectors: base.filter((n) => n !== name),
    });
  },
);

/** Save connector changes: trigger compose job and wait for completion. */
export const saveZeroConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    try {
      const local = get(internalAddedConnectors$);
      const newConnectors = local?.connectors ?? [];
      await set(syncConnectorsToCompose$, newConnectors, signal);
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
  },
);

/** Sync the connectors list via user-connectors API. */
const syncConnectorsToCompose$ = command(
  async ({ get, set }, connectorValues: string[], signal: AbortSignal) => {
    const agent = await get(zeroAgent$);
    signal.throwIfAborted();
    if (!agent) {
      throw new Error("No agent available");
    }

    const client = get(zeroClient$)(zeroUserConnectorsContract);
    const result = await client.update({
      params: { id: agent.agentId },
      body: { enabledTypes: connectorValues },
    });
    signal.throwIfAborted();

    if (result.status !== 200) {
      const detail =
        result.status === 401 || result.status === 403 || result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Save failed: ${detail}`);
    }

    await set(reloadOnboardingStatus$);
    signal.throwIfAborted();
    set(internalComposeReload$, (x) => x + 1);
  },
);
