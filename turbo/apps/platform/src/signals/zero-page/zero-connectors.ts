import { command, computed } from "ccstate";
import { reloadOnboardingStatus$ } from "./zero-onboarding.ts";
import { zeroClient$ } from "../api-client.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { accept } from "../../lib/accept.ts";
import { withCleanup } from "../utils.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "./agent-connector-authorizations.ts";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

// ---------------------------------------------------------------------------
// Authorized connectors: User↔Agent↔Connector (per-agent grant)
//  - GET/PUT /api/zero/agents/:id/user-connectors
//  - Data: { enabledTypes: string[] } — connector types this user authorized
//    for the current agent
// ---------------------------------------------------------------------------

/** Connectors the current user has authorized for the current agent. */
const authorizedConnectors$ = computed(async (get) => {
  const agentId = await get(currentChatAgentRecordId$);
  if (!agentId) {
    return [];
  }
  const authorizations = await get(agentConnectorAuthorizations({ agentId }));
  return [...authorizations.enabledTypes];
});

export const zeroAuthorizedConnectors$ = computed(async (get) => {
  return await get(authorizedConnectors$);
});

/** Grant the current agent access to a connector. */
export const authorizeConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(updateAuthorizedConnectors$, "add", name, signal);
  },
);

/** Revoke the current agent's access to a connector. */
export const deauthorizeConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(updateAuthorizedConnectors$, "remove", name, signal);
  },
);

/** Atomically add/remove an authorized connector on the server. */
const updateAuthorizedConnectors$ = command(
  async (
    { get, set },
    operation: "add" | "remove",
    connectorValue: string,
    signal: AbortSignal,
  ) => {
    const agentId = await get(currentChatAgentRecordId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("No agent available");
    }

    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: agentId },
          body: { enabledTypes: [connectorValue], operation },
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        set(reloadAgentConnectorAuthorizations$);
      },
    );
    signal.throwIfAborted();

    await set(reloadOnboardingStatus$);
    signal.throwIfAborted();
  },
);
