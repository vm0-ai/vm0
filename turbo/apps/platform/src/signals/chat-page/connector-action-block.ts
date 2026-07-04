import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { connectorRefSchema } from "@vm0/api-contracts/contracts/connector-ref";
import { customConnectorProposalSchema } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  connectorCatalogDisplayMetadataByRef$,
  connectorCatalogStatusByRef$,
  connectors$,
  type ConnectorCatalogDisplayMetadata,
} from "../external/connectors.ts";
import {
  justConnectedTypes$,
  setSelectedConnectorType$,
} from "../zero-page/settings/connectors.ts";
import { authorizeConnector$ as authorizeDirectedConnector$ } from "../connectors-page/directed-authorize-type.ts";
import { isAgentConnectorAuthorized } from "../zero-page/agent-connector-authorizations.ts";
import { jsonParseBase64UrlOr } from "../utils.ts";

export interface ConnectorActionDescriptor {
  connectorRef: string;
  connectorType: ConnectorType | null;
  agentId: string;
  originalUrl: string;
}

export interface ConnectorActionSignals {
  displayMetadata$: Computed<Promise<ConnectorCatalogDisplayMetadata | null>>;
  available$: Computed<Promise<boolean>>;
  connected$: Computed<Promise<boolean>>;
  authorized$: Computed<Promise<boolean>>;
  complete$: Computed<Promise<boolean>>;
  activate$: Command<Promise<void>, [AbortSignal]>;
}

export type ConnectorActionBlock = ConnectorActionDescriptor &
  ConnectorActionSignals & {
    type: "connector-action";
    id: string;
  };

export interface CustomConnectorActionDescriptor {
  displayName: string;
  agentId: string | null;
  originalUrl: string;
}

export type CustomConnectorActionBlock = CustomConnectorActionDescriptor & {
  type: "custom-connector-action";
  id: string;
};

type ActiveChatConnectorAction = ConnectorActionDescriptor & {
  connectorType: ConnectorType;
  markComplete$: Command<void, []>;
};

const activeChatConnectorActionState$ = state<ActiveChatConnectorAction | null>(
  null,
);

export const activeChatConnectorAction$ = computed((get) => {
  return get(activeChatConnectorActionState$);
});

export const closeChatConnectorActionConnectDialog$ = command(({ set }) => {
  set(activeChatConnectorActionState$, null);
  set(setSelectedConnectorType$, null);
});

export const completeChatConnectorActionConnect$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const active = get(activeChatConnectorActionState$);
    if (!active) {
      return;
    }
    await set(
      authorizeDirectedConnector$,
      active.connectorType,
      active.agentId,
      signal,
    );
    signal.throwIfAborted();
    set(active.markComplete$);
    set(closeChatConnectorActionConnectDialog$);
  },
);

function parseConnectorType(value: string): ConnectorType | null {
  const parsed = connectorTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CONNECTOR_AUTHORIZE_BASE_URL = "https://app.vm0.ai";

export function parseConnectorAuthorizeUrl(
  value: string,
): ConnectorActionDescriptor | null {
  if (!URL.canParse(value, CONNECTOR_AUTHORIZE_BASE_URL)) {
    return null;
  }
  const url = new URL(value, CONNECTOR_AUTHORIZE_BASE_URL);
  if (url.origin !== CONNECTOR_AUTHORIZE_BASE_URL) {
    return null;
  }

  const match = url.pathname.match(
    /^\/connectors\/([^/]+)\/(?:authorize|connect)$/,
  );
  const connectorRef = match?.[1]?.toLowerCase();
  const agentId = url.searchParams.get("agentId");
  if (
    !connectorRef ||
    !agentId ||
    !connectorRefSchema.safeParse(connectorRef).success
  ) {
    return null;
  }

  return {
    connectorRef,
    connectorType: parseConnectorType(connectorRef),
    agentId,
    originalUrl: value,
  };
}

export function parseCustomConnectorProposalUrl(
  value: string,
): CustomConnectorActionDescriptor | null {
  if (!URL.canParse(value, CONNECTOR_AUTHORIZE_BASE_URL)) {
    return null;
  }
  const url = new URL(value, CONNECTOR_AUTHORIZE_BASE_URL);
  if (url.pathname !== "/connectors/custom/proposal") {
    return null;
  }
  const payload = url.searchParams.get("p");
  if (!payload) {
    return null;
  }
  const decoded = jsonParseBase64UrlOr<unknown | null>(payload, null);
  if (decoded === null) {
    return null;
  }
  const parsed = customConnectorProposalSchema.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  return {
    displayName: parsed.data.displayName,
    agentId: url.searchParams.get("agentId"),
    originalUrl: value,
  };
}

export function createCustomConnectorActionBlock(
  id: string,
  descriptor: CustomConnectorActionDescriptor,
): CustomConnectorActionBlock {
  return {
    type: "custom-connector-action",
    id,
    ...descriptor,
  };
}

export function createConnectorActionBlock(
  id: string,
  descriptor: ConnectorActionDescriptor,
): ConnectorActionBlock {
  const connectedOverride$ = state(false);
  const authorizedOverride$ = state(false);

  const markComplete$ = command(({ set }) => {
    set(connectedOverride$, true);
    set(authorizedOverride$, true);
  });

  const displayMetadata$ = computed(async (get) => {
    const metadataByRef = await get(connectorCatalogDisplayMetadataByRef$);
    return metadataByRef.get(descriptor.connectorRef) ?? null;
  });

  const available$ = computed(async (get): Promise<boolean> => {
    const displayMetadata = await get(displayMetadata$);
    return displayMetadata !== null && descriptor.connectorType !== null;
  });

  const connected$ = computed(async (get): Promise<boolean> => {
    const connectorType = descriptor.connectorType;
    if (connectorType === null) {
      return false;
    }
    if (
      get(connectedOverride$) ||
      get(justConnectedTypes$).has(connectorType)
    ) {
      return true;
    }
    const statusByRef = await get(connectorCatalogStatusByRef$);
    return statusByRef.get(descriptor.connectorRef)?.connected ?? false;
  });

  const authorized$ = computed(async (get): Promise<boolean> => {
    const connectorType = descriptor.connectorType;
    if (connectorType === null) {
      return false;
    }
    if (get(authorizedOverride$)) {
      return true;
    }
    return await get(
      isAgentConnectorAuthorized({
        agentId: descriptor.agentId,
        connectorType,
      }),
    );
  });

  const complete$ = computed(async (get): Promise<boolean> => {
    const available = await get(available$);
    if (!available) {
      return false;
    }

    const [connected, authorized] = await Promise.all([
      get(connected$),
      get(authorized$),
    ]);
    return connected && authorized;
  });

  const activate$ = command(async ({ get, set }, signal: AbortSignal) => {
    const connectorType = descriptor.connectorType;
    if (connectorType === null) {
      return;
    }
    const available = await get(available$);
    signal.throwIfAborted();
    if (!available) {
      return;
    }

    const connected = await get(connected$);
    signal.throwIfAborted();
    if (connected) {
      await set(
        authorizeDirectedConnector$,
        connectorType,
        descriptor.agentId,
        signal,
      );
      signal.throwIfAborted();
      set(markComplete$);
      return;
    }

    await get(connectors$);
    signal.throwIfAborted();
    set(activeChatConnectorActionState$, {
      ...descriptor,
      connectorType,
      markComplete$,
    });
    set(setSelectedConnectorType$, connectorType);
  });

  return {
    type: "connector-action",
    id,
    ...descriptor,
    displayMetadata$,
    available$,
    connected$,
    authorized$,
    complete$,
    activate$,
  };
}
