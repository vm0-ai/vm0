import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import type { ConnectorDeviceAuthStartOptions } from "@vm0/connectors/connectors";
import {
  CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY,
  isConnectorAppOauthCallbackEnabled,
} from "@vm0/connectors/app-oauth-callback";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  zeroConnectorScopeDiffContract,
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOpenIdStartContract,
  zeroConnectorOauthStartContract,
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";
import type {
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorListResponse,
  ConnectorReconnectReason,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  connectorCatalogStatus$,
  connectors$,
  deleteConnector$,
  reloadConnectors$,
} from "../../external/connectors.ts";
import { replaceSearchParams$, searchParams$ } from "../../route.ts";
import { connectorAgentAuthorizations$ } from "./connector-access-management.ts";
import {
  OAUTH_API_BASE,
  zeroClient$,
  type ZeroClientFactory,
} from "../../api-client.ts";
import {
  jsonParseOr,
  resetSignal,
  setLoop,
  tapError,
  withCleanup,
} from "../../utils.ts";
import { setAblyLoop$ } from "../../realtime.ts";
import { localStorageSignals } from "../../external/local-storage.ts";
import { subagents$ } from "../../agent.ts";
import { reloadAgentConnectorAuthorizations$ } from "../agent-connector-authorizations.ts";
import { sanitizeTokenInputRecord } from "./token-input.ts";
import { IN_VITEST } from "../../../env.ts";
import { connectorRedirectingPath } from "../../connectors-page/connector-redirecting.ts";

const HIDDEN_CONNECTIONS_STORAGE_KEY = "vm0.connections.hiddenTypes";

const { get$: hiddenConnectorRefsRaw$, set$: setHiddenConnectorRefs$ } =
  localStorageSignals(HIDDEN_CONNECTIONS_STORAGE_KEY);
const { set$: setConnectorAppOauthCallbackMetadata$ } = localStorageSignals(
  CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY,
);
type PostConnectOptions = {
  readonly authorizeVisibleAgents?: boolean;
  readonly connectorLabel?: string;
  readonly agentId?: string;
};
type BrowserAuthPostConnectOptions = PostConnectOptions & {
  readonly connectorIcon: PublicConnectorCatalogIcon;
};
// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ConnectorConnectLaunchMode = "browser-auth" | "no-auth" | "modal";
type BrowserAuthGrantKind = "auth-code" | "openid-auth";

export type ConnectorCatalogBrowserAuthMethodDetail =
  PublicConnectorCatalogAuthMethodDetail & {
    readonly grantKind: BrowserAuthGrantKind;
  };

export function manualGrantInputValuesForMethod(
  method: Pick<PublicConnectorCatalogAuthMethodDetail, "manualFields">,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    method.manualFields.flatMap((field) => {
      const value = values[field.id];
      return value === undefined ? [] : ([[field.id, value]] as const);
    }),
  );
}

type ConnectorStatusGrantKind =
  PublicConnectorCatalogAuthMethodDetail["grantKind"];

function isBrowserAuthGrantKind(
  grantKind: ConnectorStatusGrantKind,
): grantKind is BrowserAuthGrantKind {
  return grantKind === "auth-code" || grantKind === "openid-auth";
}

function isCatalogBrowserAuthMethodDetail(
  method: PublicConnectorCatalogAuthMethodDetail,
): method is ConnectorCatalogBrowserAuthMethodDetail {
  return isBrowserAuthGrantKind(method.grantKind);
}

export function getOnlyAvailableCatalogBrowserAuthMethodDetail(connector: {
  readonly authMethods: readonly PublicConnectorCatalogAuthMethodDetail[];
  readonly singleAuthCodeAuthMethodId: ConnectorAuthMethodId | null;
}): ConnectorCatalogBrowserAuthMethodDetail | null {
  const [method] = connector.authMethods;
  if (
    connector.authMethods.length !== 1 ||
    !method ||
    !isCatalogBrowserAuthMethodDetail(method)
  ) {
    return null;
  }
  if (
    method.grantKind === "auth-code" &&
    connector.singleAuthCodeAuthMethodId !== method.id
  ) {
    return null;
  }
  return method;
}

function isNoAuthGrantKind(grantKind: ConnectorStatusGrantKind): boolean {
  return grantKind === "none";
}

export function getConnectorStatusAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
  authMethod: ConnectorAuthMethodId,
): PublicConnectorCatalogAuthMethodDetail | null {
  return (
    connector.authMethods.find((method) => {
      return method.id === authMethod;
    }) ?? null
  );
}

export function getConnectorStatusAuthMethodsByGrantKind(
  connector: PublicConnectorCatalogStatusItem,
  grantKind: ConnectorStatusGrantKind,
): PublicConnectorCatalogAuthMethodDetail[] {
  return connector.authMethods.filter((method) => {
    return method.grantKind === grantKind;
  });
}

export function getOnlyManualConnectorStatusAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
): PublicConnectorCatalogAuthMethodDetail | null {
  const methods = getConnectorStatusAuthMethodsByGrantKind(connector, "manual");
  return methods.length === 1 ? (methods[0] ?? null) : null;
}

export function hasConnectorStatusProviderDrivenConnectMethod(
  connector: PublicConnectorCatalogStatusItem,
): boolean {
  return connector.authMethods.some((method) => {
    return (
      method.grantKind === "auth-code" ||
      method.grantKind === "openid-auth" ||
      method.grantKind === "device-auth" ||
      method.grantKind === "external-code" ||
      method.grantKind === "managed"
    );
  });
}

export function hasConnectorStatusAuthCodeGrant(
  connector: PublicConnectorCatalogStatusItem,
): boolean {
  return getConnectorStatusAuthMethodsByGrantKind(connector, "auth-code").some(
    () => {
      return true;
    },
  );
}

export function hasConnectorStatusBrowserAuthGrant(
  connector: PublicConnectorCatalogStatusItem,
): boolean {
  return connector.authMethods.some((method) => {
    return isBrowserAuthGrantKind(method.grantKind);
  });
}

export function getConnectorStatusConnectLaunchMode(
  connector: PublicConnectorCatalogStatusItem,
): ConnectorConnectLaunchMode {
  if (getOnlyAvailableStatusBrowserAuthMethod(connector)) {
    return "browser-auth";
  }
  if (getOnlyAvailableStatusNoAuthMethod(connector)) {
    return "no-auth";
  }
  return "modal";
}

export function getAvailableStatusAuthCodeAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!parsed.success) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, parsed.data);
  if (method?.grantKind !== "auth-code") {
    return null;
  }
  return parsed.data;
}

export function getOnlyAvailableStatusAuthCodeAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const authMethod = connector.singleAuthCodeAuthMethodId;
  const [method] = connector.authMethods;
  if (
    connector.authMethods.length !== 1 ||
    !authMethod ||
    method?.id !== authMethod
  ) {
    return null;
  }
  return getAvailableStatusAuthCodeAuthMethod(connector, authMethod);
}

export function getAvailableStatusBrowserAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!parsed.success) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, parsed.data);
  if (!method || !isBrowserAuthGrantKind(method.grantKind)) {
    return null;
  }
  return parsed.data;
}

export function getOnlyAvailableStatusBrowserAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const [method] = connector.authMethods;
  if (connector.authMethods.length !== 1 || !method) {
    return null;
  }
  if (method?.grantKind === "auth-code") {
    return getOnlyAvailableStatusAuthCodeAuthMethod(connector);
  }
  return method.grantKind === "openid-auth" ? method.id : null;
}

export function getOnlyAvailableStatusBrowserAuthMethodDetail(
  connector: PublicConnectorCatalogStatusItem,
): PublicConnectorCatalogAuthMethodDetail | null {
  const authMethod = getOnlyAvailableStatusBrowserAuthMethod(connector);
  return authMethod
    ? getConnectorStatusAuthMethod(connector, authMethod)
    : null;
}

export function getAvailableStatusNoAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!parsed.success) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, parsed.data);
  if (!method || !isNoAuthGrantKind(method.grantKind)) {
    return null;
  }
  return parsed.data;
}

export function getOnlyAvailableStatusNoAuthMethod(
  connector: PublicConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const [method] = connector.authMethods;
  if (connector.authMethods.length !== 1 || !method) {
    return null;
  }
  return getAvailableStatusNoAuthMethod(connector, method.id);
}

function connectorTokenExpiresAtMs(
  connector: PublicConnectorCatalogStatusItem,
): number | null {
  if (!connector.tokenExpiresAt) {
    return null;
  }
  const value = Date.parse(connector.tokenExpiresAt);
  return Number.isFinite(value) ? value : null;
}

export function connectorCurrentConnectionStatus(
  connector: PublicConnectorCatalogStatusItem,
  nowMs = now(),
): PublicConnectorCatalogConnectionStatus {
  if (connector.connectionStatus === "not-connected") {
    return "not-connected";
  }
  if (!connector.authMethodSupportsRefresh) {
    const tokenExpiresAtMs = connectorTokenExpiresAtMs(connector);
    if (tokenExpiresAtMs !== null && tokenExpiresAtMs <= nowMs) {
      return "reconnect-required";
    }
  }
  return connector.connectionStatus;
}

function formatExpiryCountdown(value: number, unit: "day" | "hour"): string {
  return `Expires in ${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function connectorExpiryCountdownText(
  connector: PublicConnectorCatalogStatusItem,
  nowMs = now(),
): string | null {
  if (
    connectorCurrentConnectionStatus(connector, nowMs) !== "connected" ||
    connector.authMethodSupportsRefresh
  ) {
    return null;
  }
  const tokenExpiresAtMs = connectorTokenExpiresAtMs(connector);
  if (tokenExpiresAtMs === null) {
    return null;
  }
  const remainingMs = tokenExpiresAtMs - nowMs;
  if (remainingMs >= DAY_MS) {
    return formatExpiryCountdown(Math.ceil(remainingMs / DAY_MS), "day");
  }
  if (remainingMs < HOUR_MS) {
    return "Expires in less than 1 hour";
  }
  return formatExpiryCountdown(Math.ceil(remainingMs / HOUR_MS), "hour");
}

const reconnectReasonTooltipText = {
  provider_session_expired:
    "The provider session expired. Reconnect to continue.",
  authorization_expired_or_revoked:
    "Authorization expired or was revoked. Reconnect to continue.",
  credential_expired: "The stored credential expired. Reconnect to continue.",
} satisfies Record<ConnectorReconnectReason, string>;

export function connectorReconnectReasonTooltipText(
  connector: PublicConnectorCatalogStatusItem,
): string | null {
  const reason = connector.connection?.reconnectReason;
  return reason ? reconnectReasonTooltipText[reason] : null;
}

/**
 * Case-insensitive substring match across label, ref, description, and tags.
 * Returns true when `search` is empty, so callers can use it directly as a filter.
 */
export function matchesConnectorSearch(
  search: string,
  connector: Pick<
    PublicConnectorCatalogStatusItem,
    "connectorRef" | "description" | "label" | "tags"
  >,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (connector.label.toLowerCase().includes(needle)) {
    return true;
  }
  if (connector.connectorRef.toLowerCase().includes(needle)) {
    return true;
  }
  if (connector.description.toLowerCase().includes(needle)) {
    return true;
  }
  if (
    connector.tags?.some((t) => {
      return t.toLowerCase().includes(needle);
    })
  ) {
    return true;
  }
  return false;
}

export const allConnectorCatalogItems$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogStatus$);
  const items = [...connectors];

  // Sort connected connectors to the top of the list
  items.sort((a, b) => {
    if (a.connected === b.connected) {
      return 0;
    }
    return a.connected ? -1 : 1;
  });

  return items;
});

// ---------------------------------------------------------------------------
// Hidden connector refs (removed from list by user; persisted in localStorage)
// ---------------------------------------------------------------------------

const hiddenConnectorRefs$ = computed((get): Set<ConnectorRef> => {
  const raw = get(hiddenConnectorRefsRaw$);
  if (!raw) {
    return new Set();
  }
  return new Set(jsonParseOr<ConnectorRef[]>(raw, []));
});

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

const CONNECTORS_SEARCH_PARAM = "keywords";
const CONNECTORS_CONNECTION_FILTER_PARAM = "connection";
const CONNECTORS_AGENT_FILTER_PREFIX = "agent:";

// A single, mutually-exclusive connector filter: all connectors, a connection
// status, or the connectors a given agent is authorized to use.
export type ConnectorsConnectionFilter =
  | { readonly kind: "all" }
  | { readonly kind: "connected" }
  | { readonly kind: "not-connected" }
  | { readonly kind: "agent"; readonly agentId: string };

export const connectorsConnectionFilter$ = computed(
  (get): ConnectorsConnectionFilter => {
    const raw = get(searchParams$).get(CONNECTORS_CONNECTION_FILTER_PARAM);
    if (raw === "connected") {
      return { kind: "connected" };
    }
    if (raw === "not-connected") {
      return { kind: "not-connected" };
    }
    if (raw?.startsWith(CONNECTORS_AGENT_FILTER_PREFIX)) {
      const agentId = raw.slice(CONNECTORS_AGENT_FILTER_PREFIX.length);
      if (agentId) {
        return { kind: "agent", agentId };
      }
    }
    return { kind: "all" };
  },
);

export const connectorsSearch$ = computed((get) => {
  return get(searchParams$).get(CONNECTORS_SEARCH_PARAM) ?? "";
});

export const filteredConnectorCatalogItems$ = computed(async (get) => {
  const keyword = get(connectorsSearch$);
  const effectiveFilter = get(connectorsConnectionFilter$);

  const agentEnabledRefs =
    effectiveFilter.kind === "agent"
      ? new Set(
          (await get(connectorAgentAuthorizations$)).find((row) => {
            return row.agent.id === effectiveFilter.agentId;
          })?.enabledTypes ?? [],
        )
      : null;

  const allConnectorCatalogItems = await get(allConnectorCatalogItems$);
  return allConnectorCatalogItems.filter((connector) => {
    if (!matchesConnectorSearch(keyword, connector)) {
      return false;
    }
    if (effectiveFilter.kind === "connected") {
      return connector.connected;
    }
    if (effectiveFilter.kind === "not-connected") {
      return !connector.connected;
    }
    if (effectiveFilter.kind === "agent") {
      return agentEnabledRefs?.has(connector.connectorRef) ?? false;
    }
    return true;
  });
});

export const setConnectorsSearch$ = command(({ get, set }, value: string) => {
  const params = new URLSearchParams(get(searchParams$));
  if (value.trim()) {
    params.set(CONNECTORS_SEARCH_PARAM, value);
  } else {
    params.delete(CONNECTORS_SEARCH_PARAM);
  }
  set(replaceSearchParams$, params);
});

export const setConnectorsConnectionFilter$ = command(
  ({ get, set }, value: ConnectorsConnectionFilter) => {
    const params = new URLSearchParams(get(searchParams$));
    if (value.kind === "all") {
      params.delete(CONNECTORS_CONNECTION_FILTER_PARAM);
    } else if (value.kind === "agent") {
      params.set(
        CONNECTORS_CONNECTION_FILTER_PARAM,
        `${CONNECTORS_AGENT_FILTER_PREFIX}${value.agentId}`,
      );
    } else {
      params.set(CONNECTORS_CONNECTION_FILTER_PARAM, value.kind);
    }
    set(replaceSearchParams$, params);
  },
);

// ---------------------------------------------------------------------------
// Selected connector for connect modal
// ---------------------------------------------------------------------------

const internalSelectedConnectorRef$ = state<ConnectorRef | null>(null);

type ActiveConnectorOAuthDeviceAuthState = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly approvalOpened: boolean;
  readonly errorMessage: string | null;
};

type ActiveConnectorExternalCodeState = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly authorizationUrl: string;
  readonly expiresAtMs: number;
  readonly code: string;
  readonly errorMessage: string | null;
};

export type ConnectorOAuthDeviceAuthState =
  | {
      readonly status: "idle";
      readonly connectorRef: ConnectorRef | null;
    }
  | {
      readonly status: "starting";
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorOAuthDeviceAuthState & {
      readonly status: "pending" | "polling";
    })
  | {
      readonly status: "denied" | "expired" | "error";
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

export type ConnectorExternalCodeState =
  | {
      readonly status: "idle";
      readonly connectorRef: ConnectorRef | null;
    }
  | {
      readonly status: "starting";
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorExternalCodeState & {
      readonly status: "pending";
    })
  | {
      readonly status: "expired" | "error";
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

type ConnectorConnectFlowState = {
  readonly connectorRef: ConnectorRef;
  readonly id: string;
};

function createIdleConnectorOAuthDeviceAuthState(
  connectorRef: ConnectorRef | null = null,
): ConnectorOAuthDeviceAuthState {
  return { status: "idle", connectorRef };
}

const internalConnectorOAuthDeviceAuthState$ =
  state<ConnectorOAuthDeviceAuthState>(
    createIdleConnectorOAuthDeviceAuthState(),
  );

function createIdleConnectorExternalCodeState(
  connectorRef: ConnectorRef | null = null,
): ConnectorExternalCodeState {
  return { status: "idle", connectorRef };
}

const internalConnectorExternalCodeState$ = state<ConnectorExternalCodeState>(
  createIdleConnectorExternalCodeState(),
);
const resetConnectorOAuthDeviceAuthFlowSignal$ = resetSignal();
const resetConnectorExternalCodeFlowSignal$ = resetSignal();
const connectorOAuthDeviceAuthStartOptionValues$ = state<
  Record<string, Record<string, string>>
>({});

export const selectedConnectorRef$ = computed((get) => {
  return get(internalSelectedConnectorRef$);
});
export const setSelectedConnectorRef$ = command(
  ({ get, set }, connectorRef: ConnectorRef | null) => {
    set(internalSelectedConnectorRef$, connectorRef);
    const deviceAuthCurrent = get(internalConnectorOAuthDeviceAuthState$);
    if (connectorRef !== deviceAuthCurrent.connectorRef) {
      set(resetConnectorOAuthDeviceAuthFlowSignal$);
      set(
        internalConnectorOAuthDeviceAuthState$,
        createIdleConnectorOAuthDeviceAuthState(connectorRef),
      );
    }
    const externalCodeCurrent = get(internalConnectorExternalCodeState$);
    if (connectorRef !== externalCodeCurrent.connectorRef) {
      set(resetConnectorExternalCodeFlowSignal$);
      set(
        internalConnectorExternalCodeState$,
        createIdleConnectorExternalCodeState(connectorRef),
      );
    }
  },
);

export const connectorOAuthDeviceAuthState$ = computed((get) => {
  return get(internalConnectorOAuthDeviceAuthState$);
});

export const connectorExternalCodeState$ = computed((get) => {
  return get(internalConnectorExternalCodeState$);
});

function connectorOAuthDeviceAuthStateIsActive(
  state: ConnectorOAuthDeviceAuthState,
): boolean {
  return (
    state.status === "starting" ||
    state.status === "pending" ||
    state.status === "polling"
  );
}

function connectorExternalCodeStateIsActive(
  state: ConnectorExternalCodeState,
): boolean {
  return state.status === "starting" || state.status === "pending";
}

function connectorConnectOperationIsActive({
  authCodeConnectorRef,
  connectFlow,
  deviceAuthState,
  externalCodeState,
}: {
  readonly authCodeConnectorRef: ConnectorRef | null;
  readonly connectFlow: ConnectorConnectFlowState | null;
  readonly deviceAuthState: ConnectorOAuthDeviceAuthState;
  readonly externalCodeState: ConnectorExternalCodeState;
}): boolean {
  return (
    authCodeConnectorRef !== null ||
    connectFlow !== null ||
    connectorOAuthDeviceAuthStateIsActive(deviceAuthState) ||
    connectorExternalCodeStateIsActive(externalCodeState)
  );
}

function connectorOAuthDeviceAuthStartOptionsKey(
  connectorRef: ConnectorRef,
  authMethod: ConnectorAuthMethodId,
): string {
  return `${connectorRef}:${authMethod}`;
}

export const connectorOAuthDeviceAuthStartOptionValuesFor$ = computed((get) => {
  const values = get(connectorOAuthDeviceAuthStartOptionValues$);
  return (connectorRef: ConnectorRef, authMethod: ConnectorAuthMethodId) => {
    return (
      values[
        connectorOAuthDeviceAuthStartOptionsKey(connectorRef, authMethod)
      ] ?? {}
    );
  };
});

export const setConnectorOAuthDeviceAuthStartOptionValue$ = command(
  (
    { get, set },
    args: {
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly name: string;
      readonly value: string;
    },
  ) => {
    const key = connectorOAuthDeviceAuthStartOptionsKey(
      args.connectorRef,
      args.authMethod,
    );
    const current = get(connectorOAuthDeviceAuthStartOptionValues$);
    set(connectorOAuthDeviceAuthStartOptionValues$, {
      ...current,
      [key]: {
        ...current[key],
        [args.name]: args.value,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Scope review modal state
// ---------------------------------------------------------------------------

const internalScopeReviewConnectorRef$ = state<ConnectorRef | null>(null);
export const scopeReviewConnectorRef$ = computed((get) => {
  return get(internalScopeReviewConnectorRef$);
});

export const scopeDiff$ = computed(async (get) => {
  const connectorRef = get(internalScopeReviewConnectorRef$);
  if (!connectorRef) {
    return null;
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorScopeDiffContract);
  const result = await accept(
    client.getScopeDiff({ params: { type: connectorRef } }),
    [200],
  );
  return result.body;
});

export const setScopeReviewConnectorRef$ = command(
  ({ set }, connectorRef: ConnectorRef | null) => {
    set(internalScopeReviewConnectorRef$, connectorRef);
  },
);

// ---------------------------------------------------------------------------
// Manual grant form state (used by connector connection dialogs)
// ---------------------------------------------------------------------------

const manualGrantFormValues$ = state<Record<string, Record<string, string>>>(
  {},
);
export const manualGrantFormSubmitting$ = computed((get) => {
  return get(internalManualGrantFormSubmitting$);
});
const internalManualGrantFormSubmitting$ = state<string | null>(null);

export const setManualGrantFormValue$ = command(
  ({ get, set }, connectorRef: ConnectorRef, name: string, value: string) => {
    const current = get(manualGrantFormValues$);
    set(manualGrantFormValues$, {
      ...current,
      [connectorRef]: { ...current[connectorRef], [name]: value },
    });
  },
);

export const clearManualGrantForm$ = command(
  ({ get, set }, connectorRef: ConnectorRef) => {
    const current = get(manualGrantFormValues$);
    const updated = { ...current };
    delete updated[connectorRef];
    set(manualGrantFormValues$, updated);
  },
);

export const manualGrantFormValuesFor$ = computed((get) => {
  const values = get(manualGrantFormValues$);
  return (connectorRef: ConnectorRef) => {
    return values[connectorRef] ?? {};
  };
});

export const setManualGrantFormSubmitting$ = command(
  ({ set }, value: string | null) => {
    set(internalManualGrantFormSubmitting$, value);
  },
);

type FinishConnectorConnectionOptions = PostConnectOptions & {
  readonly clearSelectedConnector?: boolean;
  readonly reloadConnectors?: boolean;
  readonly toastMessage?: string | null;
};

const authorizeConnectorForVisibleAgents$ = command(
  async (
    { get, set },
    connectorRef: ConnectorRef,
    signal: AbortSignal,
  ): Promise<void> => {
    const visibleSubagents = await get(subagents$);
    signal.throwIfAborted();
    const client = get(zeroClient$)(zeroUserConnectorsContract);
    await withCleanup(
      Promise.all(
        visibleSubagents.map(async (agent) => {
          await accept(
            client.update({
              params: { id: agent.id },
              body: { enabledTypes: [connectorRef], operation: "add" },
              fetchOptions: { signal },
            }),
            [200, 404],
          );
        }),
      ),
      () => {
        set(reloadAgentConnectorAuthorizations$);
      },
    );
    signal.throwIfAborted();
  },
);

const finishConnectorConnection$ = command(
  async (
    { get, set },
    connectorRef: ConnectorRef,
    options: FinishConnectorConnectionOptions,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (options.authorizeVisibleAgents) {
      await set(authorizeConnectorForVisibleAgents$, connectorRef, signal);
    }
    set(internalJustConnectedRefs$, (prev) => {
      return new Set([...prev, connectorRef]);
    });
    if (options.reloadConnectors !== false) {
      set(reloadConnectors$);
    }
    if (options.agentId) {
      set(reloadAgentConnectorAuthorizations$);
    }

    const hidden = new Set(get(hiddenConnectorRefs$));
    hidden.delete(connectorRef);
    set(setHiddenConnectorRefs$, JSON.stringify([...hidden]));

    if (options.toastMessage !== null) {
      toast.success(
        options.toastMessage ??
          `${options.connectorLabel ?? connectorRef} connected`,
        {
          id: `connector-connected-${connectorRef}`,
        },
      );
    }
    if (options.clearSelectedConnector) {
      set(internalSelectedConnectorRef$, null);
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// Submit manual connector grant command
// ---------------------------------------------------------------------------

type SubmitManualGrantParams = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly inputValues: Record<string, string>;
  readonly options: PostConnectOptions;
};

export const submitManualGrant$ = command(
  async (
    { get, set },
    { connectorRef, authMethod, inputValues, options }: SubmitManualGrantParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorRef: get(internalPollingOAuthAuthCodeConnectorRef$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const connectorClient = createClient(zeroConnectorManualGrantContract);
        await accept(
          connectorClient.connect({
            params: { type: connectorRef },
            body: {
              authMethod,
              authorizeAgent: true,
              ...(options.agentId ? { agentId: options.agentId } : {}),
              values: sanitizeTokenInputRecord(inputValues),
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        connectorStateChanged = true;
        signal.throwIfAborted();
        await set(
          finishConnectorConnection$,
          connectorRef,
          {
            ...options,
            reloadConnectors: false,
            toastMessage: `${options.connectorLabel ?? connectorRef} connected successfully`,
          },
          signal,
        );
        return true;
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        if (connectorStateChanged) {
          set(reloadConnectors$);
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Enable no-auth connector grant command
// ---------------------------------------------------------------------------

type ConnectNoAuthParams = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

export const connectConnectorNoAuth$ = command(
  async (
    { get, set },
    { connectorRef, authMethod, options }: ConnectNoAuthParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorRef: get(internalPollingOAuthAuthCodeConnectorRef$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const connectorClient = createClient(zeroConnectorNoAuthGrantContract);
        await accept(
          connectorClient.connect({
            params: { type: connectorRef },
            body: {
              authMethod,
              authorizeAgent: true,
              ...(options.agentId ? { agentId: options.agentId } : {}),
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        connectorStateChanged = true;
        signal.throwIfAborted();
        await set(
          finishConnectorConnection$,
          connectorRef,
          {
            ...options,
            reloadConnectors: false,
            toastMessage: `${options.connectorLabel ?? connectorRef} enabled successfully`,
          },
          signal,
        );
        return true;
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        if (connectorStateChanged) {
          set(reloadConnectors$);
        }
      },
    );
  },
);

export const connectConnectorNoAuthAndSettle$ = command(
  async (
    { set },
    args: ConnectNoAuthParams & {
      readonly onSuccess: () => void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(connectConnectorNoAuth$, args, signal);
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess();
    }
  },
);

// ---------------------------------------------------------------------------
// Polling state (for connect flow)
// ---------------------------------------------------------------------------

const internalPollingOAuthAuthCodeConnectorRef$ = state<ConnectorRef | null>(
  null,
);
const internalConnectFlowState$ = state<ConnectorConnectFlowState | null>(null);

export const pollingOAuthAuthCodeConnectorRef$ = computed((get) => {
  return get(internalPollingOAuthAuthCodeConnectorRef$);
});

export const pollingOAuthDeviceAuthConnectorRef$ = computed((get) => {
  const current = get(internalConnectorOAuthDeviceAuthState$);
  return current.status === "pending" || current.status === "polling"
    ? current.connectorRef
    : null;
});

export const connectFlowConnectorRef$ = computed((get) => {
  return get(internalConnectFlowState$)?.connectorRef ?? null;
});

export const runConnectorConnectSuccess$ = command(
  async (
    { set },
    connectorRef: ConnectorRef,
    onSuccess: () => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> => {
    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        signal.throwIfAborted();
        await onSuccess();
        signal.throwIfAborted();
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Optimistic connected state — bridges the gap between connect success and
// allConnectorCatalogItems$ recomputation so the UI doesn't flash.
// ---------------------------------------------------------------------------

const internalJustConnectedRefs$ = state<Set<ConnectorRef>>(new Set());

/** Refs that were just connected but may not yet be reflected in allConnectorCatalogItems$. */
export const justConnectedRefs$ = computed((get) => {
  return get(internalJustConnectedRefs$);
});

/**
 * Disconnect a connector and clear its optimistic "just connected" flag.
 *
 * Without this cleanup, a connector that was connected earlier in the session
 * stays in the Connected section of /connectors after disconnect because the
 * optimistic override in allConnectorCatalogItems$ wins over the fresh
 * `connected = false` from the API (regression #10272).
 */
export const disconnectConnector$ = command(
  async (
    { set },
    connectorRef: ConnectorRef,
    connectorLabel: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(deleteConnector$, connectorRef, signal);
    signal.throwIfAborted();
    set(internalJustConnectedRefs$, (prev) => {
      if (!prev.has(connectorRef)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(connectorRef);
      return next;
    });
    toast.success(`${connectorLabel} disconnected`, {
      id: `connector-disconnected-${connectorRef}`,
    });
  },
);

function createConnectorConnectFlowState(
  connectorRef: ConnectorRef,
): ConnectorConnectFlowState {
  return {
    connectorRef,
    id: `${connectorRef}-connect-${now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function secondsToMilliseconds(value: number): number {
  return Math.max(0, value * 1000);
}

// ---------------------------------------------------------------------------
// OAuth device authorization flow state
// ---------------------------------------------------------------------------

const OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS = IN_VITEST ? 10 : 1000;

type PollConnectorOAuthDeviceAuthArgs = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly createClient: ZeroClientFactory;
  readonly options: PostConnectOptions;
};

type ConnectConnectorOAuthDeviceAuthParams = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
  readonly startOptions?: ConnectorDeviceAuthStartOptions;
};

function connectorOAuthDeviceAuthStartBody(
  args: ConnectConnectorOAuthDeviceAuthParams,
) {
  const optionEntries = Object.entries(args.startOptions ?? {});
  return {
    authMethod: args.authMethod,
    authorizeAgent: true as const,
    ...(args.options.agentId ? { agentId: args.options.agentId } : {}),
    ...(optionEntries.length > 0
      ? { options: Object.fromEntries(optionEntries) }
      : {}),
  };
}

type ConnectorOAuthDeviceAuthSessionClient = InitClientReturn<
  typeof zeroConnectorOauthDeviceAuthSessionContract,
  InitClientArgs
>;

type PollConnectorOAuthDeviceAuthIterationArgs = Omit<
  PollConnectorOAuthDeviceAuthArgs,
  "createClient"
> & {
  readonly client: ConnectorOAuthDeviceAuthSessionClient;
};

type PollConnectorOAuthDeviceAuthIterationOutcome = {
  readonly stop: boolean;
  readonly completed?: true;
  readonly expired?: true;
};

function createConnectorOAuthDeviceAuthRequestId(
  connectorRef: ConnectorRef,
): string {
  return `${connectorRef}-oauth-device-${now()}-${Math.random().toString(36).slice(2)}`;
}

function getOAuthDeviceAuthTerminalMessage(
  result: Extract<
    ConnectorOauthDeviceAuthSessionPollResponse,
    { readonly status: "denied" | "expired" | "error" }
  >,
): string {
  if (result.errorMessage) {
    return result.errorMessage;
  }
  switch (result.status) {
    case "denied": {
      return "Connection was denied. Start again to retry.";
    }
    case "expired": {
      return "Connection session expired. Start again to retry.";
    }
    case "error": {
      return "Connection failed. Start again to retry.";
    }
  }
}

function isCurrentConnectorOAuthDeviceAuthRequest(
  state: ConnectorOAuthDeviceAuthState,
  connectorRef: ConnectorRef,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorOAuthDeviceAuthState & {
  readonly status: "pending" | "polling";
} {
  return (
    (state.status === "pending" || state.status === "polling") &&
    state.connectorRef === connectorRef &&
    state.authMethod === authMethod &&
    state.requestId === requestId
  );
}

export const clearConnectorOAuthDeviceAuth$ = command(({ set }) => {
  set(resetConnectorOAuthDeviceAuthFlowSignal$);
  set(
    internalConnectorOAuthDeviceAuthState$,
    createIdleConnectorOAuthDeviceAuthState(),
  );
});

export const openConnectorOAuthDeviceAuthVerificationPage$ = command(
  (
    { get, set },
    connectorRef: ConnectorRef,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorOAuthDeviceAuthState$);
    if (
      (current.status !== "pending" && current.status !== "polling") ||
      current.connectorRef !== connectorRef ||
      current.authMethod !== authMethod
    ) {
      return false;
    }

    const verificationUrl =
      current.verificationUriComplete ?? current.verificationUri;
    const verificationWindow = window.open(verificationUrl, "_blank");
    if (!verificationWindow) {
      set(internalConnectorOAuthDeviceAuthState$, {
        ...current,
        errorMessage: "Could not open the verification page. Try again.",
      });
      return false;
    }

    verificationWindow.opener = null;
    set(internalConnectorOAuthDeviceAuthState$, {
      ...current,
      status: "pending",
      approvalOpened: true,
      errorMessage: null,
    });
    return true;
  },
);

const pollConnectorOAuthDeviceAuthOnce$ = command(
  async (
    { get, set },
    {
      client,
      connectorRef,
      authMethod,
      requestId,
      options,
    }: PollConnectorOAuthDeviceAuthIterationArgs,
    signal: AbortSignal,
  ): Promise<PollConnectorOAuthDeviceAuthIterationOutcome> => {
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const current = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(
            current,
            connectorRef,
            authMethod,
            requestId,
          )
        ) {
          return { stop: true };
        }

        const remainingMs = current.expiresAtMs - now();
        if (remainingMs <= 0) {
          return { stop: true, expired: true };
        }

        if (!current.approvalOpened) {
          await delay(
            Math.min(OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS, remainingMs),
            { signal },
          );
          signal.throwIfAborted();
          return { stop: false };
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          ...current,
          status: "polling",
        });

        const pollResponse = await accept(
          client.poll({
            params: { type: connectorRef, sessionId: current.sessionId },
            body: { sessionToken: current.sessionToken },
            fetchOptions: { signal },
          }),
          [200],
        );
        const pollResult = pollResponse.body;
        if (pollResult.status === "complete") {
          connectorStateChanged = true;
        }

        const latest = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(
            latest,
            connectorRef,
            authMethod,
            requestId,
          )
        ) {
          return { stop: true };
        }

        if (pollResult.status === "complete") {
          signal.throwIfAborted();
          await set(
            finishConnectorConnection$,
            connectorRef,
            {
              ...options,
              clearSelectedConnector: true,
              reloadConnectors: false,
            },
            signal,
          );
          set(
            internalConnectorOAuthDeviceAuthState$,
            createIdleConnectorOAuthDeviceAuthState(),
          );
          return { stop: true, completed: true };
        }

        signal.throwIfAborted();

        if (pollResult.status !== "pending") {
          set(internalConnectorOAuthDeviceAuthState$, {
            status: pollResult.status,
            connectorRef,
            authMethod,
            message: getOAuthDeviceAuthTerminalMessage(pollResult),
          });
          return { stop: true };
        }

        const pollIntervalMs = Math.max(
          secondsToMilliseconds(pollResult.interval),
          OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS,
        );
        set(internalConnectorOAuthDeviceAuthState$, {
          ...latest,
          status: "pending",
          pollIntervalMs,
          errorMessage: null,
        });

        const nextRemainingMs = latest.expiresAtMs - now();
        if (nextRemainingMs <= 0) {
          return { stop: true, expired: true };
        }
        await delay(Math.min(pollIntervalMs, nextRemainingMs), { signal });
        signal.throwIfAborted();
        return { stop: false };
      })(),
      () => {
        if (connectorStateChanged) {
          set(reloadConnectors$);
        }
      },
    );
  },
);

const pollConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    {
      connectorRef,
      authMethod,
      requestId,
      createClient,
      options,
    }: PollConnectorOAuthDeviceAuthArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const client = createClient(zeroConnectorOauthDeviceAuthSessionContract, {
      apiBase: OAUTH_API_BASE,
    });
    const isCurrentRequest = (state: ConnectorOAuthDeviceAuthState) => {
      return isCurrentConnectorOAuthDeviceAuthRequest(
        state,
        connectorRef,
        authMethod,
        requestId,
      );
    };
    let completed = false;
    let expired = false;

    await setLoop(
      async (sig) => {
        const outcome = await set(
          pollConnectorOAuthDeviceAuthOnce$,
          { client, connectorRef, authMethod, requestId, options },
          sig,
        );
        sig.throwIfAborted();
        if (outcome.completed) {
          completed = true;
        }
        if (outcome.expired) {
          expired = true;
        }
        return outcome.stop;
      },
      0,
      signal,
      { retryTransientErrors: false },
    );
    signal.throwIfAborted();

    const latest = get(internalConnectorOAuthDeviceAuthState$);
    if (expired && isCurrentRequest(latest)) {
      set(internalConnectorOAuthDeviceAuthState$, {
        status: "expired",
        connectorRef,
        authMethod,
        message: "Connection session expired. Start again to retry.",
      });
    }
    return completed;
  },
);

const connectConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    args: ConnectConnectorOAuthDeviceAuthParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { connectorRef, authMethod, options } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorRef: get(internalPollingOAuthAuthCodeConnectorRef$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorOAuthDeviceAuthRequestId(connectorRef);
        const flowSignal = set(
          resetConnectorOAuthDeviceAuthFlowSignal$,
          signal,
        );
        set(internalConnectorOAuthDeviceAuthState$, {
          status: "starting",
          connectorRef,
          authMethod,
          requestId,
        });

        const createClient = get(zeroClient$);
        const client = createClient(
          zeroConnectorOauthDeviceAuthSessionContract,
          { apiBase: OAUTH_API_BASE },
        );
        const startResponse = await tapError(
          accept(
            client.create({
              params: { type: connectorRef },
              body: connectorOAuthDeviceAuthStartBody(args),
              fetchOptions: { signal: flowSignal },
            }),
            [200],
          ),
        );
        flowSignal.throwIfAborted();
        const startResult = startResponse?.body ?? null;
        if (!startResponse) {
          if (flowSignal.aborted) {
            return false;
          }
          set(internalConnectorOAuthDeviceAuthState$, {
            status: "error",
            connectorRef,
            authMethod,
            message: "Connection failed. Start again to retry.",
          });
        }
        flowSignal.throwIfAborted();
        if (!startResult) {
          return false;
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          status: "pending",
          connectorRef,
          authMethod,
          requestId,
          sessionId: startResult.sessionId,
          sessionToken: startResult.sessionToken,
          userCode: startResult.userCode,
          verificationUri: startResult.verificationUri,
          verificationUriComplete: startResult.verificationUriComplete,
          expiresAtMs: now() + secondsToMilliseconds(startResult.expiresIn),
          pollIntervalMs: Math.max(
            secondsToMilliseconds(startResult.interval),
            OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS,
          ),
          approvalOpened: false,
          errorMessage: null,
        });

        return await set(
          pollConnectorOAuthDeviceAuth$,
          {
            connectorRef,
            authMethod,
            requestId,
            createClient,
            options,
          },
          flowSignal,
        );
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        set(internalConnectorOAuthDeviceAuthState$, (current) => {
          if (
            requestId === null ||
            current.connectorRef !== connectorRef ||
            (current.status !== "starting" &&
              current.status !== "pending" &&
              current.status !== "polling") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorOAuthDeviceAuthState(connectorRef);
        });
      },
    );
  },
);

export const connectConnectorOAuthDeviceAuthAndSettle$ = command(
  async (
    { set },
    args: {
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly onSuccess: () => void | Promise<void>;
      readonly options: PostConnectOptions;
      readonly startOptions?: ConnectorDeviceAuthStartOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthDeviceAuth$,
      {
        connectorRef: args.connectorRef,
        authMethod: args.authMethod,
        options: args.options,
        startOptions: args.startOptions,
      },
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess();
    }
  },
);

// ---------------------------------------------------------------------------
// External-code authorization flow state
// ---------------------------------------------------------------------------

type ConnectConnectorExternalCodeParams = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly agentId?: string;
};

type CompleteConnectorExternalCodeParams = {
  readonly connectorRef: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

function createConnectorExternalCodeRequestId(
  connectorRef: ConnectorRef,
): string {
  return `${connectorRef}-external-code-${now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentConnectorExternalCodeRequest(
  state: ConnectorExternalCodeState,
  connectorRef: ConnectorRef,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorExternalCodeState & {
  readonly status: "pending";
} {
  return (
    state.status === "pending" &&
    state.connectorRef === connectorRef &&
    state.authMethod === authMethod &&
    state.requestId === requestId
  );
}

export const clearConnectorExternalCode$ = command(({ set }) => {
  set(resetConnectorExternalCodeFlowSignal$);
  set(
    internalConnectorExternalCodeState$,
    createIdleConnectorExternalCodeState(),
  );
});

export const setConnectorExternalCodeAuthorizationCode$ = command(
  (
    { get, set },
    args: {
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly code: string;
    },
  ) => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorRef !== args.connectorRef ||
      current.authMethod !== args.authMethod
    ) {
      return false;
    }
    set(internalConnectorExternalCodeState$, {
      ...current,
      code: args.code,
      errorMessage: null,
    });
    return true;
  },
);

export const openConnectorExternalCodeAuthorizationPage$ = command(
  (
    { get, set },
    connectorRef: ConnectorRef,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorRef !== connectorRef ||
      current.authMethod !== authMethod
    ) {
      return false;
    }

    const authWindow = window.open(
      current.authorizationUrl,
      "_blank",
      "noopener,noreferrer",
    );
    if (authWindow) {
      authWindow.opener = null;
    }

    set(internalConnectorExternalCodeState$, {
      ...current,
      errorMessage: null,
    });
    return true;
  },
);

export const connectConnectorExternalCode$ = command(
  async (
    { get, set },
    args: ConnectConnectorExternalCodeParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { connectorRef, authMethod } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorRef: get(internalPollingOAuthAuthCodeConnectorRef$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorExternalCodeRequestId(connectorRef);
        const flowSignal = set(resetConnectorExternalCodeFlowSignal$, signal);
        set(internalConnectorExternalCodeState$, {
          status: "starting",
          connectorRef,
          authMethod,
          requestId,
        });

        const createClient = get(zeroClient$);
        const client = createClient(zeroConnectorExternalCodeSessionContract, {
          apiBase: OAUTH_API_BASE,
        });
        const startResponse = await tapError(
          accept(
            client.create({
              params: { type: connectorRef },
              body: {
                authMethod,
                authorizeAgent: true,
                ...(args.agentId ? { agentId: args.agentId } : {}),
              },
              fetchOptions: { signal: flowSignal },
            }),
            [200],
          ),
        );
        flowSignal.throwIfAborted();
        const startResult = startResponse?.body ?? null;
        if (!startResponse) {
          if (flowSignal.aborted) {
            return false;
          }
          set(internalConnectorExternalCodeState$, {
            status: "error",
            connectorRef,
            authMethod,
            message: "Connection failed. Start again to retry.",
          });
        }
        flowSignal.throwIfAborted();
        if (!startResult) {
          return false;
        }

        set(internalConnectorExternalCodeState$, {
          status: "pending",
          connectorRef,
          authMethod,
          requestId,
          sessionId: startResult.sessionId,
          sessionToken: startResult.sessionToken,
          authorizationUrl: startResult.authorizationUrl,
          expiresAtMs: now() + secondsToMilliseconds(startResult.expiresIn),
          code: "",
          errorMessage: null,
        });
        return true;
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        set(internalConnectorExternalCodeState$, (current) => {
          if (
            !signal.aborted ||
            requestId === null ||
            current.connectorRef !== connectorRef ||
            (current.status !== "starting" && current.status !== "pending") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorExternalCodeState(connectorRef);
        });
      },
    );
  },
);

const completeConnectorExternalCode$ = command(
  async (
    { get, set },
    args: CompleteConnectorExternalCodeParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { connectorRef, authMethod, options } = args;
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorRef !== connectorRef ||
      current.authMethod !== authMethod
    ) {
      return false;
    }
    if (now() > current.expiresAtMs) {
      set(internalConnectorExternalCodeState$, {
        status: "expired",
        connectorRef,
        authMethod,
        message: "Connection session expired. Start again to retry.",
      });
      return false;
    }

    const code = current.code.trim();
    if (!code) {
      set(internalConnectorExternalCodeState$, {
        ...current,
        errorMessage: `Enter the code from ${options.connectorLabel ?? connectorRef}.`,
      });
      return false;
    }

    set(internalConnectorExternalCodeState$, {
      ...current,
      code,
      errorMessage: null,
    });

    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const flowSignal = set(resetConnectorExternalCodeFlowSignal$, signal);
        const createClient = get(zeroClient$);
        const client = createClient(zeroConnectorExternalCodeSessionContract, {
          apiBase: OAUTH_API_BASE,
        });
        const completeResult = await accept(
          client.complete({
            params: { type: connectorRef, sessionId: current.sessionId },
            body: {
              sessionToken: current.sessionToken,
              code,
            },
            fetchOptions: { signal: flowSignal },
          }),
          [200, 400],
        );
        if (completeResult.status === 200) {
          connectorStateChanged = true;
        }
        signal.throwIfAborted();
        flowSignal.throwIfAborted();
        const latest = get(internalConnectorExternalCodeState$);
        if (
          !isCurrentConnectorExternalCodeRequest(
            latest,
            connectorRef,
            authMethod,
            current.requestId,
          )
        ) {
          return false;
        }

        if (completeResult.status === 400) {
          set(internalConnectorExternalCodeState$, {
            ...latest,
            errorMessage: completeResult.body.error.message,
          });
          return false;
        }

        await set(
          finishConnectorConnection$,
          connectorRef,
          {
            ...options,
            clearSelectedConnector: true,
            reloadConnectors: false,
          },
          flowSignal,
        );
        set(
          internalConnectorExternalCodeState$,
          createIdleConnectorExternalCodeState(),
        );
        return true;
      })(),
      () => {
        if (connectorStateChanged) {
          set(reloadConnectors$);
        }
      },
    );
  },
);

export const completeConnectorExternalCodeAndSettle$ = command(
  async (
    { set },
    args: CompleteConnectorExternalCodeParams & {
      readonly onSuccess: () => void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      completeConnectorExternalCode$,
      {
        connectorRef: args.connectorRef,
        authMethod: args.authMethod,
        options: args.options,
      },
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess();
    }
  },
);

// ---------------------------------------------------------------------------
// Standalone mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the app is running as an installed PWA (standalone display mode).
 * In standalone mode, window.open() with popup features is blocked by iOS Safari.
 */
export function isStandaloneMode(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

const OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS = IN_VITEST ? 10 : 250;

async function waitForOAuthAuthCodePopupClosed(
  authWindow: Pick<Window, "closed">,
  signal: AbortSignal,
): Promise<"popupClosed"> {
  signal.throwIfAborted();

  let closed = false;
  await setLoop(
    () => {
      if (authWindow.closed) {
        closed = true;
        return true;
      }
      return false;
    },
    OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS,
    signal,
  );

  signal.throwIfAborted();
  if (!closed) {
    throw new Error("OAuth auth code popup wait ended before popup closed");
  }
  return "popupClosed";
}

const resetOAuthAuthCodeWaitSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

function connectorMatchesAuthMethod(
  connector: ConnectorResponse,
  connectorRef: ConnectorRef,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return connector.type === connectorRef && connector.authMethod === authMethod;
}

function createConnectorOAuthAuthCodeChangedCommand(
  connectorRef: ConnectorRef,
  authMethod: ConnectorAuthMethodId,
  agentId: string | undefined,
) {
  // Snapshot taken on the first body invocation: `null` marks "no connector
  // yet" and an `updatedAt` value marks "reconnect scenario — wait for it to
  // change". The snapshot must happen inside the loop body so we start from the
  // freshest server state, not a cached signal value.
  let initialUpdatedAt: string | null | undefined;

  return command(async ({ get }, sig: AbortSignal): Promise<boolean> => {
    const client = get(zeroClient$)(zeroConnectorsMainContract);
    const result = await accept(
      client.list({ fetchOptions: { signal: sig } }),
      [200],
    );
    const polled = (result.body as ConnectorListResponse).connectors;
    const current = polled.find((c) => {
      return connectorMatchesAuthMethod(c, connectorRef, authMethod);
    });

    if (initialUpdatedAt === undefined) {
      initialUpdatedAt = current?.updatedAt ?? null;
      return false;
    }
    if (current) {
      // initialUpdatedAt === null means the connector didn't exist on the first
      // fetch; any subsequent appearance signals completion.
      const connectionChanged =
        initialUpdatedAt === null || current.updatedAt !== initialUpdatedAt;
      if (!connectionChanged || !agentId) {
        return connectionChanged;
      }
      const authorization = await accept(
        get(zeroClient$)(zeroUserConnectorsContract).get({
          params: { id: agentId },
          fetchOptions: { signal: sig },
        }),
        [200, 404],
      );
      return (
        authorization.status === 200 &&
        authorization.body.enabledTypes.includes(connectorRef)
      );
    }
    return false;
  });
}

const openConnectorOAuthAuthCodeWindow$ = command(
  async (
    { get, set },
    args: {
      readonly connectorRef: ConnectorRef;
      readonly method: PublicConnectorCatalogAuthMethodDetail;
      readonly connectorLabel: string;
      readonly connectorIcon: PublicConnectorCatalogIcon;
      readonly agentId: string | undefined;
      readonly beforeStart: (signal: AbortSignal) => Promise<void>;
    },
    signal: AbortSignal,
  ) => {
    const standalone = isStandaloneMode();
    if (isConnectorAppOauthCallbackEnabled(args.connectorRef)) {
      set(
        setConnectorAppOauthCallbackMetadata$,
        JSON.stringify({
          connectorRef: args.connectorRef,
          icon: args.connectorIcon,
        }),
      );
    }

    // In standalone (PWA) mode, omit popup features so iOS Safari opens the
    // URL in the external browser instead of blocking it as a popup.
    const popupFeatures = standalone ? undefined : "width=600,height=700";
    const redirectingPath = connectorRedirectingPath({
      type: args.connectorRef,
      label: args.connectorLabel,
      icon: args.connectorIcon,
    });
    const authWindow = window.open(redirectingPath, "_blank", popupFeatures);

    if (!authWindow && !standalone) {
      throw new Error("Failed to open authorization window");
    }
    if (authWindow) {
      authWindow.opener = null;
    }

    let navigated = false;
    await withCleanup(
      (async () => {
        if (!isBrowserAuthGrantKind(args.method.grantKind)) {
          throw new Error(
            `${args.connectorRef}/${args.method.id} does not support browser authorization`,
          );
        }

        await args.beforeStart(signal);
        signal.throwIfAborted();

        const startResult =
          args.method.grantKind === "openid-auth"
            ? await accept(
                get(zeroClient$)(zeroConnectorOpenIdStartContract, {
                  apiBase: "api",
                }).start({
                  params: { type: args.connectorRef },
                  body: {
                    authMethod: args.method.id,
                    authorizeAgent: true,
                    ...(args.agentId ? { agentId: args.agentId } : {}),
                  },
                  fetchOptions: { signal },
                }),
                [200],
              )
            : await accept(
                get(zeroClient$)(zeroConnectorOauthStartContract, {
                  apiBase: OAUTH_API_BASE,
                }).start({
                  params: { type: args.connectorRef },
                  body: {
                    authMethod: args.method.id,
                    authorizeAgent: true,
                    ...(isConnectorAppOauthCallbackEnabled(args.connectorRef)
                      ? { callbackTarget: "app" as const }
                      : {}),
                    ...(args.agentId ? { agentId: args.agentId } : {}),
                  },
                  fetchOptions: { signal },
                }),
                [200],
              );
        signal.throwIfAborted();

        if (authWindow) {
          authWindow.location.href = startResult.body.authorizationUrl;
          navigated = true;
        } else if (standalone) {
          window.location.href = startResult.body.authorizationUrl;
        }
      })(),
      () => {
        if (authWindow && !navigated) {
          if (signal.aborted) {
            authWindow.close();
          } else {
            authWindow.location.href = connectorRedirectingPath({
              type: args.connectorRef,
              label: args.connectorLabel,
              icon: args.connectorIcon,
              status: "error",
            });
          }
        }
      },
    );
    signal.throwIfAborted();

    return authWindow;
  },
);

export const connectConnectorOAuthAuthCode$ = command(
  async (
    { get, set },
    connectorRef: ConnectorRef,
    method: PublicConnectorCatalogAuthMethodDetail,
    options: BrowserAuthPostConnectOptions,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorRef: get(internalPollingOAuthAuthCodeConnectorRef$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorRef);
    set(internalConnectFlowState$, flow);
    set(internalPollingOAuthAuthCodeConnectorRef$, connectorRef);

    return await withCleanup(
      (async () => {
        // Snapshot before starting the provider flow. The popup is already open
        // by the time this runs, so we keep browser popup blockers satisfied
        // while avoiding a race where a very fast callback completes before the
        // first poll baseline is captured.
        const onConnectorChanged$ = createConnectorOAuthAuthCodeChangedCommand(
          connectorRef,
          method.id,
          options.agentId,
        );
        const authWindow = await set(
          openConnectorOAuthAuthCodeWindow$,
          {
            connectorRef,
            method,
            connectorLabel: options.connectorLabel ?? connectorRef,
            connectorIcon: options.connectorIcon,
            agentId: options.agentId,
            beforeStart: async (sig) => {
              await set(onConnectorChanged$, sig);
            },
          },
          signal,
        );
        signal.throwIfAborted();

        // Wait for the browser authorization flow to complete. The callback
        // publishes `connector:changed`, and the subscription rechecks server
        // state.
        const waitSignal = set(resetOAuthAuthCodeWaitSignal$, signal);
        const waitForConnectorChanged = async () => {
          await set(
            setAblyLoop$,
            {
              topic: "connector:changed",
              loopCommand$: onConnectorChanged$,
              options: { runOnSubscribe: true },
            },
            waitSignal,
          );
          return "connectorChanged" as const;
        };
        const changedPromise = waitForConnectorChanged();
        const waitResult = await withCleanup(
          authWindow === null
            ? changedPromise
            : Promise.race([
                changedPromise,
                waitForOAuthAuthCodePopupClosed(authWindow, waitSignal),
              ]),
          () => {
            set(resetOAuthAuthCodeWaitSignal$, signal);
          },
        );
        signal.throwIfAborted();

        if (waitResult === "popupClosed") {
          const connectedAfterClose = await set(onConnectorChanged$, signal);
          signal.throwIfAborted();
          if (!connectedAfterClose) {
            return false;
          }
        }

        // Refresh the connectors$ cache so UI picks up the latest state.
        set(reloadConnectors$);
        const { connectors } = await get(connectors$);
        signal.throwIfAborted();

        // Mark as optimistically connected before clearing polling so the UI
        // transitions directly from "Connecting…" to "Connected" without flash.
        const isConnected = connectors.some((c) => {
          return connectorMatchesAuthMethod(c, connectorRef, method.id);
        });
        if (isConnected) {
          await set(
            finishConnectorConnection$,
            connectorRef,
            {
              ...options,
              clearSelectedConnector: true,
              reloadConnectors: false,
              toastMessage: null,
            },
            signal,
          );
        }
        return isConnected;
      })(),
      () => {
        set(internalPollingOAuthAuthCodeConnectorRef$, (current) => {
          return current === connectorRef ? null : current;
        });
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Connect via browser authorization, then run onSuccess callback.
// ---------------------------------------------------------------------------

export const connectConnectorOAuthAuthCodeAndSettle$ = command(
  async (
    { set },
    args: {
      readonly connectorRef: ConnectorRef;
      readonly method: PublicConnectorCatalogAuthMethodDetail;
      readonly onSuccess: () => void | Promise<void>;
      readonly options: BrowserAuthPostConnectOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      args.connectorRef,
      args.method,
      args.options,
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess();
    }
  },
);
