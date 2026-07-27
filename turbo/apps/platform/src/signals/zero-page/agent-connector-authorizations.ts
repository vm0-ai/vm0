import { command, computed, state, type Computed } from "ccstate";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

interface AgentConnectorAuthorizations {
  readonly agentId: string;
  readonly enabledTypes: readonly ConnectorRef[];
}

const internalAgentConnectorAuthorizationsReload$ = state(0);

const agentConnectorAuthorizationsReload$ = computed((get) => {
  return get(internalAgentConnectorAuthorizationsReload$);
});

export const reloadAgentConnectorAuthorizations$ = command(({ set }) => {
  set(internalAgentConnectorAuthorizationsReload$, (x) => {
    return x + 1;
  });
});

function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "throw" },
): Computed<Promise<AgentConnectorAuthorizations>>;
function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "null" },
): Computed<Promise<AgentConnectorAuthorizations | null>>;
function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "throw" | "null" },
): Computed<Promise<AgentConnectorAuthorizations | null>> {
  return computed(async (get): Promise<AgentConnectorAuthorizations | null> => {
    get(agentConnectorAuthorizationsReload$);
    const client = get(zeroClient$)(zeroUserConnectorsContract);
    const request = client.get({ params: { id: agentId } });
    const result =
      options.missing === "null"
        ? await accept(request, [200, 404])
        : await accept(request, [200]);
    if (result.status === 404) {
      return null;
    }
    return { agentId, enabledTypes: result.body.enabledTypes };
  });
}

export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing: "null";
}): Computed<Promise<AgentConnectorAuthorizations | null>>;
export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing?: "throw";
}): Computed<Promise<AgentConnectorAuthorizations>>;
export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing?: "throw" | "null";
}): Computed<Promise<AgentConnectorAuthorizations | null>> {
  if (params.missing === "null") {
    return createAuthorizationsAtom(params.agentId, { missing: "null" });
  }
  return createAuthorizationsAtom(params.agentId, { missing: "throw" });
}

export function isAgentConnectorAuthorized(params: {
  readonly agentId: string;
  readonly connectorRef: ConnectorRef;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const authorizations = await get(
      agentConnectorAuthorizations({ agentId: params.agentId }),
    );
    return authorizations.enabledTypes.includes(params.connectorRef);
  });
}
