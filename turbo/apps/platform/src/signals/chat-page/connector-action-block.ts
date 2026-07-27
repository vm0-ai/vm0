import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import { customConnectorProposalSchema } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { connectorCatalogStatusByRef$ } from "../external/connectors.ts";
import {
  allConnectorCatalogItems$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectorCurrentConnectionStatus,
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  setSelectedConnectorRef$,
} from "../zero-page/settings/connectors.ts";
import { resolvePlatformOriginForTarget } from "../api-base.ts";
import { authorizeConnector$ as authorizeDirectedConnector$ } from "../connectors-page/directed-authorize-ref.ts";
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
  connectorRef: ConnectorRef;
  agentId: string;
  originalUrl: string;
  callbackPrompt: ChatActionCallback["callbackPrompt"];
  threadId: ChatActionCallback["threadId"];
}

export interface ConnectorSignals extends ConnectorActionDescriptor {
  catalogItem$: Computed<Promise<PublicConnectorCatalogStatusItem | null>>;
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
  set(setSelectedConnectorRef$, null);
});

export function parseConnectorAuthorizeUrl(
  value: string,
): ConnectorActionDescriptor | null {
  const appOrigin = window.location.origin;
  const canonicalAppOrigin = resolvePlatformOriginForTarget("app");
  if (!URL.canParse(value, appOrigin)) {
    return null;
  }
  const url = new URL(value, appOrigin);
  if (url.origin !== appOrigin && url.origin !== canonicalAppOrigin) {
    return null;
  }

  const match = url.pathname.match(
    /^\/connectors\/([^/]+)\/(?:authorize|connect)$/,
  );
  const connectorRef = match?.[1]?.toLowerCase();
  const agentId = url.searchParams.get("agentId");
  const parsedConnectorRef = connectorRefSchema.safeParse(connectorRef);
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
  const appOrigin = window.location.origin;
  if (!URL.canParse(value, appOrigin)) {
    return null;
  }
  const url = new URL(value, appOrigin);
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

function createCustomConnectorSignals(
  descriptor: CustomConnectorActionDescriptor,
): CustomConnectorSignals {
  return descriptor;
}

function getDirectConnectMethod(connector: PublicConnectorCatalogStatusItem) {
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

type ConnectorActivationSignals = Pick<
  ConnectorSignals,
  "available$" | "catalogItem$" | "connected$"
>;

function createConnectorActivation(
  descriptor: ConnectorActionDescriptor,
  signals: ConnectorActivationSignals,
): ConnectorSignals["activate$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const available = await get(signals.available$);
    signal.throwIfAborted();
    if (!available) {
      return;
    }

    const [connected, catalogItem] = await Promise.all([
      get(signals.connected$),
      get(signals.catalogItem$),
    ]);
    signal.throwIfAborted();
    const reconnectRequired =
      catalogItem !== null &&
      connectorCurrentConnectionStatus(catalogItem) === "reconnect-required";
    if (connected && !reconnectRequired) {
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

    const connectorCatalogItems = await get(allConnectorCatalogItems$);
    signal.throwIfAborted();
    const connector = connectorCatalogItems.find((item) => {
      return item.connectorRef === descriptor.connectorRef;
    });
    if (!connector) {
      return;
    }

    const directConnectMethod = getDirectConnectMethod(connector);
    if (!directConnectMethod) {
      set(activeChatConnectorActionState$, descriptor);
      set(setSelectedConnectorRef$, descriptor.connectorRef);
      return;
    }

    const connectOptions = {
      connectorLabel: connector.label,
      connectorIcon: connector.icon,
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
              connectorRef: descriptor.connectorRef,
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
}

function createConnectorSignals(
  descriptor: ConnectorActionDescriptor,
): ConnectorSignals {
  const catalogItem$ = computed(async (get) => {
    const statusByRef = await get(connectorCatalogStatusByRef$);
    return statusByRef.get(descriptor.connectorRef) ?? null;
  });

  const available$ = computed(async (get): Promise<boolean> => {
    const catalogItem = await get(catalogItem$);
    return catalogItem !== null;
  });

  const connected$ = computed(async (get): Promise<boolean> => {
    const statusByRef = await get(connectorCatalogStatusByRef$);
    return statusByRef.get(descriptor.connectorRef)?.connected ?? false;
  });

  const authorized$ = computed(async (get): Promise<boolean> => {
    return await get(
      isAgentConnectorAuthorized({
        agentId: descriptor.agentId,
        connectorRef: descriptor.connectorRef,
      }),
    );
  });

  const complete$ = computed(async (get): Promise<boolean> => {
    const available = await get(available$);
    if (!available) {
      return false;
    }

    const [connected, authorized, catalogItem] = await Promise.all([
      get(connected$),
      get(authorized$),
      get(catalogItem$),
    ]);
    return (
      connected &&
      authorized &&
      catalogItem !== null &&
      connectorCurrentConnectionStatus(catalogItem) !== "reconnect-required"
    );
  });

  const activate$ = createConnectorActivation(descriptor, {
    available$,
    catalogItem$,
    connected$,
  });

  return {
    ...descriptor,
    catalogItem$,
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
