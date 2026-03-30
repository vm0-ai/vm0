import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract } from "@vm0/core";
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

/** Bump to force `zeroAgent$` to re-fetch from the API. */
export const reloadZeroCompose$ = command(({ set }) => {
  set(internalComposeReload$, (x) => x + 1);
});

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
export const addZeroConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    if (get(internalAddedConnectors$) === null) {
      set(internalAddedConnectors$, await get(seededConnectors$));
    }
    set(internalAddedConnectors$, (prev) => [...(prev ?? []), name]);
  },
);

/** Save connector changes: trigger compose job and wait for completion. */
export const saveZeroConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    try {
      const newConnectors = get(internalAddedConnectors$) ?? [];
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

/** Sync the connectors list via zero agents API. */
const syncConnectorsToCompose$ = command(
  async ({ get, set }, connectorValues: string[], signal: AbortSignal) => {
    const agent = await get(zeroAgent$);
    signal.throwIfAborted();
    if (!agent) {
      throw new Error("No agent available");
    }

    const client = get(zeroClient$)(zeroAgentsByIdContract);
    const result = await client.update({
      params: { id: agent.agentId },
      body: { connectors: connectorValues },
    });
    signal.throwIfAborted();

    if (result.status !== 200) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404 ||
        result.status === 422
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Save failed: ${detail}`);
    }

    await set(reloadOnboardingStatus$);
    signal.throwIfAborted();
    set(internalComposeReload$, (x) => x + 1);
  },
);
