import { command, computed, state } from "ccstate";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { zeroJobDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Per-agent custom connector authorization — mirrors connectors.ts but keyed
// on UUIDs from the org_custom_connectors table (not the built-in enum).
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

const reloadJobCustomConnectors$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

const seededCustomConnectors$ = computed(async (get): Promise<string[]> => {
  get(internalReload$);
  const detail = await get(zeroJobDetail$);
  if (!detail?.agentId) {
    return [];
  }
  const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
  const result = await accept(
    client.get({ params: { id: detail.agentId } }),
    [200],
  );
  return result.body.enabledIds;
});

const internalAdded$ = state<string[] | null>(null);

export const zeroJobAddedCustomConnectors$ = computed(
  async (get): Promise<string[]> => {
    const local = get(internalAdded$);
    if (local !== null) {
      return local;
    }
    return await get(seededCustomConnectors$);
  },
);

export const addZeroJobCustomConnector$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal) => {
    if (get(internalAdded$) === null) {
      set(internalAdded$, await get(seededCustomConnectors$));
    }
    set(internalAdded$, (prev) => {
      return [...(prev ?? []), id];
    });
  },
);

export const removeZeroJobCustomConnector$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal) => {
    if (get(internalAdded$) === null) {
      set(internalAdded$, await get(seededCustomConnectors$));
    }
    set(internalAdded$, (prev) => {
      return (prev ?? []).filter((s) => {
        return s !== id;
      });
    });
  },
);

export const saveZeroJobCustomConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const enabledIds = get(internalAdded$) ?? [];
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await accept(
      client.update({
        params: { id: detail.agentId },
        body: { enabledIds },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(internalAdded$, null);
    set(reloadJobCustomConnectors$);
  },
);
