import { command, computed, state, type Computed } from "ccstate";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export interface AgentConnectorAuthorizations {
  readonly agentId: string;
  readonly enabledTypes: readonly string[];
}

const internalAgentConnectorAuthorizationsReload$ = state(0);

export const agentConnectorAuthorizationsReload$ = computed((get) => {
  return get(internalAgentConnectorAuthorizationsReload$);
});

export const reloadAgentConnectorAuthorizations$ = command(({ set }) => {
  set(internalAgentConnectorAuthorizationsReload$, (x) => {
    return x + 1;
  });
});

interface AgentConnectorAuthorizationsFactory {
  (params: {
    readonly agentId: string;
    readonly missing: "null";
  }): Computed<Promise<AgentConnectorAuthorizations | null>>;
  (params: {
    readonly agentId: string;
    readonly missing?: "throw";
  }): Computed<Promise<AgentConnectorAuthorizations>>;
}

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
        ? await accept(request, [200, 404], {
            toast: false,
          })
        : await accept(request, [200]);
    if (result.status === 404) {
      return null;
    }
    return { agentId, enabledTypes: result.body.enabledTypes };
  });
}

function createAgentConnectorAuthorizationsFactory(): AgentConnectorAuthorizationsFactory {
  const authorizationsCache = new Map<
    string,
    Computed<Promise<AgentConnectorAuthorizations>>
  >();
  const nullableAuthorizationsCache = new Map<
    string,
    Computed<Promise<AgentConnectorAuthorizations | null>>
  >();

  const createAuthorizations = (
    agentId: string,
  ): Computed<Promise<AgentConnectorAuthorizations>> => {
    const existing = authorizationsCache.get(agentId);
    if (existing) {
      return existing;
    }
    const atom$ = createAuthorizationsAtom(agentId, { missing: "throw" });
    authorizationsCache.set(agentId, atom$);
    return atom$;
  };

  const createNullableAuthorizations = (
    agentId: string,
  ): Computed<Promise<AgentConnectorAuthorizations | null>> => {
    const existing = nullableAuthorizationsCache.get(agentId);
    if (existing) {
      return existing;
    }
    const atom$ = createAuthorizationsAtom(agentId, { missing: "null" });
    nullableAuthorizationsCache.set(agentId, atom$);
    return atom$;
  };

  function authorizations(params: {
    readonly agentId: string;
    readonly missing: "null";
  }): Computed<Promise<AgentConnectorAuthorizations | null>>;
  function authorizations(params: {
    readonly agentId: string;
    readonly missing?: "throw";
  }): Computed<Promise<AgentConnectorAuthorizations>>;
  function authorizations(params: {
    readonly agentId: string;
    readonly missing?: "throw" | "null";
  }): Computed<Promise<AgentConnectorAuthorizations | null>> {
    if (params.missing === "null") {
      return createNullableAuthorizations(params.agentId);
    }
    return createAuthorizations(params.agentId);
  }

  return authorizations;
}

function createAgentConnectorAuthorizedFactory(): (params: {
  readonly agentId: string;
  readonly connectorType: ConnectorType;
}) => Computed<Promise<boolean>> {
  const cache = new Map<string, Computed<Promise<boolean>>>();
  return (params) => {
    const key = `${params.agentId}:${params.connectorType}`;
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get): Promise<boolean> => {
      const authorizations = await get(
        agentConnectorAuthorizations({ agentId: params.agentId }),
      );
      return authorizations.enabledTypes.includes(params.connectorType);
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const agentConnectorAuthorizations =
  createAgentConnectorAuthorizationsFactory();

export const isAgentConnectorAuthorized =
  createAgentConnectorAuthorizedFactory();
