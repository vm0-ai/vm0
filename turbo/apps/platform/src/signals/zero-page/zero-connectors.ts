import { command, computed, state } from "ccstate";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgent$ } from "../agent-chat.ts";
import { accept } from "../../lib/accept.ts";

// ---------------------------------------------------------------------------
// Agent name resolution
// ---------------------------------------------------------------------------

const internalComposeReload$ = state(0);

const zeroAgent$ = computed(async (get) => {
  get(internalComposeReload$);
  return await get(currentChatAgent$);
});

// ---------------------------------------------------------------------------
// Connectors list: derived from user-connectors API
// ---------------------------------------------------------------------------

/** User connector permissions for this agent from the user-connectors API. */
const seededConnectors$ = computed(async (get) => {
  const agent = await get(zeroAgent$);
  if (!agent) {
    return [];
  }
  const client = get(zeroClient$)(zeroUserConnectorsContract);
  const result = await accept(
    client.get({ params: { id: agent.agentId } }),
    [200],
  );
  return result.body.enabledTypes;
});

/** Connectors enabled for the current agent. */
export const zeroAddedConnectors$ = computed(async (get) => {
  return await get(seededConnectors$);
});

/** Add a connector and save via the user-connectors API. */
export const addZeroConnector$ = command(
  async ({ get, set }, name: string, signal: AbortSignal) => {
    const current = await get(seededConnectors$);
    signal.throwIfAborted();
    if (current.includes(name)) {
      return;
    }
    await set(syncConnectorsToCompose$, [...current, name], signal);
  },
);

/** Remove a connector and save via the user-connectors API. */
export const removeZeroConnector$ = command(
  async ({ get, set }, name: string, signal: AbortSignal) => {
    const current = await get(seededConnectors$);
    signal.throwIfAborted();
    await set(
      syncConnectorsToCompose$,
      current.filter((n) => {
        return n !== name;
      }),
      signal,
    );
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
    await accept(
      client.update({
        params: { id: agent.agentId },
        body: { enabledTypes: connectorValues },
      }),
      [200],
    );
    signal.throwIfAborted();

    await set(reloadOnboardingStatus$);
    signal.throwIfAborted();
    set(internalComposeReload$, (x) => {
      return x + 1;
    });
  },
);
