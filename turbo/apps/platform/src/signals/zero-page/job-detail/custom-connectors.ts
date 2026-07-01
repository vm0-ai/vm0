import { command, computed, state } from "ccstate";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Per-agent custom connector authorization — mirrors connectors.ts but keyed
// on UUIDs from the org_custom_connectors table (not the built-in enum).
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

const reloadAgentCustomConnectors$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

const seededCustomConnectors$ = computed(async (get): Promise<string[]> => {
  get(internalReload$);
  const detail = await get(agentDetail$);
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
const internalToggleSaving$ = state(false);

export const agentAddedCustomConnectors$ = computed(
  async (get): Promise<string[]> => {
    const local = get(internalAdded$);
    if (local !== null) {
      return local;
    }
    return await get(seededCustomConnectors$);
  },
);

export const agentCustomConnectorToggleSaving$ = computed((get): boolean => {
  return get(internalToggleSaving$);
});

const addAgentCustomConnector$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal) => {
    if (get(internalAdded$) === null) {
      set(internalAdded$, await get(seededCustomConnectors$));
    }
    set(internalAdded$, (prev) => {
      return Array.from(new Set([...(prev ?? []), id]));
    });
  },
);

const removeAgentCustomConnector$ = command(
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

const saveAgentCustomConnectors$ = command(
  async (
    { get, set },
    id: string,
    operation: "add" | "remove",
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await accept(
      client.update({
        params: { id: detail.agentId },
        body: { enabledIds: [id], operation },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(internalAdded$, null);
    set(reloadAgentCustomConnectors$);
  },
);

export const toggleAgentCustomConnector$ = command(
  async (
    { get, set },
    id: string,
    checked: boolean,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (get(internalToggleSaving$)) {
      return false;
    }
    set(internalToggleSaving$, true);
    await withCleanup(
      (async () => {
        if (checked) {
          await set(addAgentCustomConnector$, id, signal);
        } else {
          await set(removeAgentCustomConnector$, id, signal);
        }
        await set(
          saveAgentCustomConnectors$,
          id,
          checked ? "add" : "remove",
          signal,
        );
      })(),
      () => {
        set(internalToggleSaving$, false);
      },
    );
    signal.throwIfAborted();
    return true;
  },
);
