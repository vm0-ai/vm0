import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  connectorCatalogRefSchema,
  type ConnectorCatalogRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import { customConnectorProposalSchema } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  connectorCatalogDisplayMetadataByRef$,
  connectorCatalogStatusByRef$,
  type ConnectorCatalogDisplayMetadata,
} from "../external/connectors.ts";
import {
  allConnectorTypes$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  setSelectedConnectorType$,
  type ConnectorTypeWithStatus,
} from "../zero-page/settings/connectors.ts";
import { authorizeConnector$ as authorizeDirectedConnector$ } from "../connectors-page/directed-authorize-type.ts";
import { isAgentConnectorAuthorized } from "../zero-page/agent-connector-authorizations.ts";
import { jsonParseBase64UrlOr } from "../utils.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
  type ChatActionCallback,
} from "./action-callback.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";

export interface ConnectorActionDescriptor {
  connectorRef: ConnectorCatalogRef;
  agentId: string;
  originalUrl: string;
  callbackPrompt: ChatActionCallback["callbackPrompt"];
  threadId: ChatActionCallback["threadId"];
}

export interface ConnectorSignals extends ConnectorActionDescriptor {
  displayMetadata$: Computed<Promise<ConnectorCatalogDisplayMetadata | null>>;
  available$: Computed<Promise<boolean>>;
  connected$: Computed<Promise<boolean>>;
  authorized$: Computed<Promise<boolean>>;
  complete$: Computed<Promise<boolean>>;
  activate$: Command<Promise<void>, [AbortSignal]>;
}

export interface ConnectorCardSignalsRegistry {
  register(descriptor: ConnectorActionDescriptor): ConnectorSignals;
  resolve(resourceKey: string): ConnectorSignals;
}

export interface CustomConnectorActionDescriptor {
  displayName: string;
  agentId: string | null;
  originalUrl: string;
}

export type CustomConnectorSignals = CustomConnectorActionDescriptor;

export interface CustomConnectorCardSignalsRegistry {
  register(descriptor: CustomConnectorActionDescriptor): CustomConnectorSignals;
  resolve(resourceKey: string): CustomConnectorSignals;
}

const activeChatConnectorActionState$ = state<ConnectorActionDescriptor | null>(
  null,
);

export const activeChatConnectorAction$ = computed((get) => {
  return get(activeChatConnectorActionState$);
});

export const closeChatConnectorActionConnectDialog$ = command(({ set }) => {
  set(activeChatConnectorActionState$, null);
  set(setSelectedConnectorType$, null);
});

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
  const parsedConnectorRef = connectorCatalogRefSchema.safeParse(connectorRef);
  if (!parsedConnectorRef.success || !agentId) {
    return null;
  }

  return {
    connectorRef: parsedConnectorRef.data,
    agentId,
    originalUrl: value,
    ...chatActionCallbackFromUrl(url),
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

export function createCustomConnectorSignals(
  descriptor: CustomConnectorActionDescriptor,
): CustomConnectorSignals {
  return descriptor;
}

function getDirectConnectMethod(connector: ConnectorTypeWithStatus) {
  const launchMode = getConnectorStatusConnectLaunchMode(connector);
  if (launchMode === "browser-auth") {
    const authMethod = getOnlyAvailableStatusBrowserAuthMethodDetail(connector);
    return authMethod ? { kind: "browser-auth" as const, authMethod } : null;
  }
  if (launchMode === "no-auth") {
    const authMethod = getOnlyAvailableStatusNoAuthMethod(connector);
    return authMethod ? { kind: "no-auth" as const, authMethod } : null;
  }
  return null;
}

export function createConnectorSignals(
  descriptor: ConnectorActionDescriptor,
): ConnectorSignals {
  const displayMetadata$ = computed(async (get) => {
    const metadataByRef = await get(connectorCatalogDisplayMetadataByRef$);
    return metadataByRef.get(descriptor.connectorRef) ?? null;
  });

  const available$ = computed(async (get): Promise<boolean> => {
    const displayMetadata = await get(displayMetadata$);
    return displayMetadata !== null;
  });

  const connected$ = computed(async (get): Promise<boolean> => {
    const statusByRef = await get(connectorCatalogStatusByRef$);
    return statusByRef.get(descriptor.connectorRef)?.connected ?? false;
  });

  const authorized$ = computed(async (get): Promise<boolean> => {
    return await get(
      isAgentConnectorAuthorized({
        agentId: descriptor.agentId,
        connectorType: descriptor.connectorRef,
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
        descriptor.connectorRef,
        descriptor.agentId,
        signal,
      );
      if (descriptor.callbackPrompt && descriptor.threadId) {
        await set(
          runChatActionCallback$,
          {
            threadId: descriptor.threadId,
            agentId: descriptor.agentId,
            callbackPrompt: descriptor.callbackPrompt,
          },
          signal,
        );
      }
      return;
    }

    const connectorTypes = await get(allConnectorTypes$);
    signal.throwIfAborted();
    const connector = connectorTypes.find((item) => {
      return item.type === descriptor.connectorRef;
    });
    if (!connector) {
      return;
    }

    const directConnectMethod = getDirectConnectMethod(connector);
    if (!directConnectMethod) {
      set(activeChatConnectorActionState$, descriptor);
      set(setSelectedConnectorType$, descriptor.connectorRef);
      return;
    }

    const connectOptions = {
      connectorLabel: connector.label,
      agentId: descriptor.agentId,
    };
    const connectionCompleted =
      directConnectMethod.kind === "browser-auth"
        ? await set(
            connectConnectorOAuthAuthCode$,
            descriptor.connectorRef,
            directConnectMethod.authMethod,
            connectOptions,
            signal,
          )
        : await set(
            connectConnectorNoAuth$,
            {
              type: descriptor.connectorRef,
              authMethod: directConnectMethod.authMethod,
              options: connectOptions,
            },
            signal,
          );
    if (
      connectionCompleted &&
      descriptor.callbackPrompt &&
      descriptor.threadId
    ) {
      await set(
        runChatActionCallback$,
        {
          threadId: descriptor.threadId,
          agentId: descriptor.agentId,
          callbackPrompt: descriptor.callbackPrompt,
        },
        signal,
      );
    }
  });

  return {
    ...descriptor,
    displayMetadata$,
    available$,
    connected$,
    authorized$,
    complete$,
    activate$,
  };
}

export function createConnectorCardSignalsRegistry(): ConnectorCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, ConnectorSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.originalUrl,
        () => {
          return createConnectorSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}

export function createCustomConnectorCardSignalsRegistry(): CustomConnectorCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, CustomConnectorSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.originalUrl,
        () => {
          return createCustomConnectorSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
