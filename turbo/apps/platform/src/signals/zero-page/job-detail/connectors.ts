import { command, computed, state } from "ccstate";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Authorized connectors: User↔Agent↔Connector (per-agent grant)
//  - GET/PUT /api/zero/agents/:id/user-connectors
//  - Data: { enabledTypes: string[] } — connector types this user authorized
//    for this agent
// ---------------------------------------------------------------------------

const authorizedConnectorsReload$ = state(0);

const reloadAgentConnectors$ = command(({ set }) => {
  set(authorizedConnectorsReload$, (prev) => {
    return prev + 1;
  });
});

const authorizedConnectors$ = computed(async (get): Promise<string[]> => {
  get(authorizedConnectorsReload$);
  const detail = await get(agentDetail$);
  if (!detail?.agentId) {
    return [];
  }
  const client = get(zeroClient$)(zeroUserConnectorsContract);
  const result = await accept(
    client.get({ params: { id: detail.agentId } }),
    [200],
  );
  return result.body.enabledTypes;
});

const internalAuthorizedConnectors$ = state<string[] | null>(null);

export const agentAuthorizedConnectors$ = computed(
  async (get): Promise<string[]> => {
    const local = get(internalAuthorizedConnectors$);
    if (local !== null) {
      return local;
    }
    return await get(authorizedConnectors$);
  },
);

export const agentConnectorsDirty$ = computed(async (get) => {
  const local = get(internalAuthorizedConnectors$);
  if (local === null) {
    return false;
  }
  const seeded = await get(authorizedConnectors$);
  if (local.length !== seeded.length) {
    return true;
  }
  const sorted = [...local].sort();
  const seededSorted = [...seeded].sort();
  return sorted.some((s, i) => {
    return s !== seededSorted[i];
  });
});

export const authorizeAgentConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    if (get(internalAuthorizedConnectors$) === null) {
      set(internalAuthorizedConnectors$, await get(authorizedConnectors$));
    }
    set(internalAuthorizedConnectors$, (prev) => {
      return [...(prev ?? []), name];
    });
  },
);

export const deauthorizeAgentConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    if (get(internalAuthorizedConnectors$) === null) {
      set(internalAuthorizedConnectors$, await get(authorizedConnectors$));
    }
    set(internalAuthorizedConnectors$, (prev) => {
      return (prev ?? []).filter((s) => {
        return s !== name;
      });
    });
  },
);

export const discardAgentConnectorsDraft$ = command(({ set }) => {
  set(internalAuthorizedConnectors$, null);
});

export const saveAgentConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const enabledTypes = get(internalAuthorizedConnectors$) ?? [];
    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await accept(
      client.update({
        params: { id: detail.agentId },
        body: { enabledTypes },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(internalAuthorizedConnectors$, null);
    set(reloadAgentConnectors$);
  },
);
