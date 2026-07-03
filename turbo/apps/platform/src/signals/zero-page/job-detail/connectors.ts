import { command, computed, state } from "ccstate";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Authorized connectors: User↔Agent↔Connector (per-agent grant)
//  - GET/PUT /api/zero/agents/:id/user-connectors
//  - Data: { enabledTypes: string[] } — connector types this user authorized
//    for this agent
// ---------------------------------------------------------------------------

const authorizedConnectors$ = computed(async (get): Promise<string[]> => {
  const detail = await get(agentDetail$);
  if (!detail?.agentId) {
    return [];
  }
  const authorizations = await get(
    agentConnectorAuthorizations({ agentId: detail.agentId }),
  );
  return [...authorizations.enabledTypes];
});

type AuthorizedConnectorsDraft = {
  readonly agentId: string;
  readonly enabledTypes: readonly string[];
};

const internalAuthorizedConnectors$ = state<AuthorizedConnectorsDraft | null>(
  null,
);

export const agentAuthorizedConnectors$ = computed(
  async (get): Promise<string[]> => {
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return [];
    }
    const local = get(internalAuthorizedConnectors$);
    if (local?.agentId === detail.agentId) {
      return [...local.enabledTypes];
    }
    return await get(authorizedConnectors$);
  },
);

const setAgentConnectorDraft$ = command(
  async (
    { get, set },
    args: {
      readonly name: string;
      readonly operation: "add" | "remove";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      return;
    }
    const current = get(internalAuthorizedConnectors$);
    const base =
      current?.agentId === detail.agentId
        ? current.enabledTypes
        : await get(authorizedConnectors$);
    signal.throwIfAborted();
    const enabledTypes =
      args.operation === "add"
        ? Array.from(new Set([...base, args.name]))
        : base.filter((s) => {
            return s !== args.name;
          });
    set(internalAuthorizedConnectors$, {
      agentId: detail.agentId,
      enabledTypes,
    });
  },
);

const clearAgentConnectorDraft$ = command(({ set }, agentId: string): void => {
  set(internalAuthorizedConnectors$, (current) => {
    return current?.agentId === agentId ? null : current;
  });
});

export const authorizeAgentConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(setAgentConnectorDraft$, { name, operation: "add" }, signal);
  },
);

export const deauthorizeAgentConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(setAgentConnectorDraft$, { name, operation: "remove" }, signal);
  },
);

export const discardAgentConnectorsDraft$ = command(({ set }) => {
  set(internalAuthorizedConnectors$, null);
});

export const saveAgentConnectors$ = command(
  async (
    { get, set },
    name: string,
    operation: "add" | "remove",
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await withCleanup(
      (async () => {
        await accept(
          client.update({
            params: { id: detail.agentId },
            body: { enabledTypes: [name], operation },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
      })(),
      () => {
        set(clearAgentConnectorDraft$, detail.agentId);
        set(reloadAgentConnectorAuthorizations$);
      },
    );
  },
);
