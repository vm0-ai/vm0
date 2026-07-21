import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import type { ConnectorDeviceAuthStartOptions } from "@vm0/connectors/connectors";
import {
  connectorCatalogAuthMethodIdSchema,
  type ConnectorCatalogAuthMethodId,
  type ConnectorCatalogRef,
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
  PublicConnectorCatalogConnection,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogPermissionSummary,
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
  OAUTH_WEB_API_BASE,
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
import { reloadAgentConnectorAuthorizations$ } from "../agent-connector-authorizations.ts";
import { sanitizeTokenInputRecord } from "./token-input.ts";
import { IN_VITEST } from "../../../env.ts";

const HIDDEN_CONNECTIONS_STORAGE_KEY = "vm0.connections.hiddenTypes";
type ConnectorType = ConnectorCatalogRef;
type ConnectorAuthMethodId = ConnectorCatalogAuthMethodId;

const { get$: hiddenConnectorTypesRaw$, set$: setHiddenConnectorTypes$ } =
  localStorageSignals(HIDDEN_CONNECTIONS_STORAGE_KEY);
type PostConnectOptions = {
  readonly connectorLabel?: string;
  readonly agentId?: string;
};
export type ConnectorConnectionStatus =
  | "not-connected"
  | "connected"
  | "scope-mismatch"
  | "reconnect-required";

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * All connector types with their connection status.
 * Uses server-authored public catalog/status data.
 */
export interface ConnectorTypeWithStatus {
  type: ConnectorType;
  label: string;
  helpText: string;
  icon: PublicConnectorCatalogIcon;
  category: string;
  /** Lowercase aliases/keywords used by connector search. */
  tags: readonly string[];
  connected: boolean;
  connector: PublicConnectorCatalogConnection | null;
  /** Public auth method metadata available after server-side filtering. */
  authMethods: readonly PublicConnectorCatalogAuthMethodDetail[];
  /** Auth methods available for this connector after availability filtering. */
  availableAuthMethods: ConnectorAuthMethodId[];
  /** Single available auth-code method if direct OAuth can be considered. */
  singleAuthCodeAuthMethodId: ConnectorAuthMethodId | null;
  /** Public notice shown before direct connect flows. */
  connectNotice: "google-security-warning" | null;
  /** True if at least one agent references this connector (env mapping). */
  usedByAgent?: boolean;
  /** True if stored grant scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
  /** User-facing connection state derived from API state and scope coverage. */
  connectionStatus: ConnectorConnectionStatus;
  /** Stored credential expiry returned by the API. */
  tokenExpiresAt: string | null;
  /** True when the selected auth method can refresh runtime access. */
  authMethodSupportsRefresh: boolean;
  /** Public permission summary returned by the catalog status API. */
  permissionSummary: PublicConnectorCatalogPermissionSummary;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ConnectorConnectLaunchMode = "browser-auth" | "no-auth" | "modal";
type BrowserAuthGrantKind = "auth-code" | "openid-auth";

export type ConnectorCatalogBrowserAuthMethodDetail =
  PublicConnectorCatalogAuthMethodDetail & {
    readonly grantKind: BrowserAuthGrantKind;
  };

export type ConnectorStatusAuthMethodDetail = Omit<
  PublicConnectorCatalogAuthMethodDetail,
  "id"
> & {
  readonly id: ConnectorAuthMethodId;
};

export function manualGrantInputValuesForMethod(
  method: Pick<ConnectorStatusAuthMethodDetail, "manualFields">,
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

function parseConnectorStatusAuthMethodDetail(
  connector: ConnectorTypeWithStatus,
  method: PublicConnectorCatalogAuthMethodDetail,
): ConnectorStatusAuthMethodDetail | null {
  if (!connector.availableAuthMethods.includes(method.id)) {
    return null;
  }
  return method;
}

export function getConnectorStatusAuthMethod(
  connector: ConnectorTypeWithStatus,
  authMethod: ConnectorAuthMethodId,
): ConnectorStatusAuthMethodDetail | null {
  for (const method of connector.authMethods) {
    if (method.id !== authMethod) {
      continue;
    }
    return parseConnectorStatusAuthMethodDetail(connector, method);
  }
  return null;
}

export function getConnectorStatusAuthMethodsByGrantKind(
  connector: ConnectorTypeWithStatus,
  grantKind: ConnectorStatusGrantKind,
): ConnectorStatusAuthMethodDetail[] {
  return connector.authMethods.flatMap((method) => {
    if (method.grantKind !== grantKind) {
      return [];
    }
    const parsed = parseConnectorStatusAuthMethodDetail(connector, method);
    return parsed ? [parsed] : [];
  });
}

export function getOnlyManualConnectorStatusAuthMethod(
  connector: ConnectorTypeWithStatus,
): ConnectorStatusAuthMethodDetail | null {
  const methods = getConnectorStatusAuthMethodsByGrantKind(connector, "manual");
  return methods.length === 1 ? (methods[0] ?? null) : null;
}

export function hasConnectorStatusProviderDrivenConnectMethod(
  connector: ConnectorTypeWithStatus,
): boolean {
  return connector.authMethods.some((method) => {
    const parsed = parseConnectorStatusAuthMethodDetail(connector, method);
    if (!parsed) {
      return false;
    }
    return (
      parsed.grantKind === "auth-code" ||
      parsed.grantKind === "openid-auth" ||
      parsed.grantKind === "device-auth" ||
      parsed.grantKind === "external-code" ||
      parsed.grantKind === "managed"
    );
  });
}

export function hasConnectorStatusAuthCodeGrant(
  connector: ConnectorTypeWithStatus,
): boolean {
  return getConnectorStatusAuthMethodsByGrantKind(connector, "auth-code").some(
    () => {
      return true;
    },
  );
}

export function hasConnectorStatusBrowserAuthGrant(
  connector: ConnectorTypeWithStatus,
): boolean {
  return connector.authMethods.some((method) => {
    const parsed = parseConnectorStatusAuthMethodDetail(connector, method);
    return parsed ? isBrowserAuthGrantKind(parsed.grantKind) : false;
  });
}

export function getConnectorStatusConnectLaunchMode(
  connector: ConnectorTypeWithStatus,
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
  connector: ConnectorTypeWithStatus,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorCatalogAuthMethodIdSchema.safeParse(authMethod);
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
  connector: ConnectorTypeWithStatus,
): ConnectorAuthMethodId | null {
  const authMethod = connector.singleAuthCodeAuthMethodId;
  if (
    connector.availableAuthMethods.length !== 1 ||
    !authMethod ||
    connector.availableAuthMethods[0] !== authMethod
  ) {
    return null;
  }
  return getAvailableStatusAuthCodeAuthMethod(connector, authMethod);
}

export function getAvailableStatusBrowserAuthMethod(
  connector: ConnectorTypeWithStatus,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorCatalogAuthMethodIdSchema.safeParse(authMethod);
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
  connector: ConnectorTypeWithStatus,
): ConnectorAuthMethodId | null {
  const [authMethod] = connector.availableAuthMethods;
  if (connector.availableAuthMethods.length !== 1 || !authMethod) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, authMethod);
  if (method?.grantKind === "auth-code") {
    return getOnlyAvailableStatusAuthCodeAuthMethod(connector);
  }
  return method?.grantKind === "openid-auth" ? authMethod : null;
}

export function getOnlyAvailableStatusBrowserAuthMethodDetail(
  connector: ConnectorTypeWithStatus,
): ConnectorStatusAuthMethodDetail | null {
  const authMethod = getOnlyAvailableStatusBrowserAuthMethod(connector);
  return authMethod
    ? getConnectorStatusAuthMethod(connector, authMethod)
    : null;
}

export function getAvailableStatusNoAuthMethod(
  connector: ConnectorTypeWithStatus,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorCatalogAuthMethodIdSchema.safeParse(authMethod);
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
  connector: ConnectorTypeWithStatus,
): ConnectorAuthMethodId | null {
  const [authMethod] = connector.availableAuthMethods;
  if (connector.availableAuthMethods.length !== 1 || !authMethod) {
    return null;
  }
  return getAvailableStatusNoAuthMethod(connector, authMethod);
}

function connectorTokenExpiresAtMs(
  connector: ConnectorTypeWithStatus,
): number | null {
  if (!connector.tokenExpiresAt) {
    return null;
  }
  const value = Date.parse(connector.tokenExpiresAt);
  return Number.isFinite(value) ? value : null;
}

export function connectorCurrentConnectionStatus(
  connector: ConnectorTypeWithStatus,
  nowMs = now(),
): ConnectorConnectionStatus {
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
  connector: ConnectorTypeWithStatus,
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
  connector: ConnectorTypeWithStatus,
): string | null {
  const reason = connector.connector?.reconnectReason;
  return reason ? reconnectReasonTooltipText[reason] : null;
}

function connectorCatalogStatusItemToConnectorType(
  item: PublicConnectorCatalogStatusItem,
): ConnectorTypeWithStatus {
  return {
    type: item.connectorRef,
    label: item.label,
    helpText: item.description,
    icon: item.icon,
    category: item.category,
    tags: item.tags,
    connected: item.connected,
    connector: item.connection,
    authMethods: item.authMethods,
    availableAuthMethods: item.authMethods.map((authMethod) => {
      return authMethod.id;
    }),
    singleAuthCodeAuthMethodId: item.singleAuthCodeAuthMethodId,
    connectNotice: item.connectNotice,
    scopeMismatch: item.scopeMismatch,
    connectionStatus: item.connectionStatus,
    tokenExpiresAt: item.tokenExpiresAt,
    authMethodSupportsRefresh: item.authMethodSupportsRefresh,
    permissionSummary: item.permissionSummary,
  };
}

/**
 * Case-insensitive substring match across label, type, helpText, and tags.
 * Returns true when `search` is empty, so callers can use it directly as a filter.
 */
export function matchesConnectorSearch(
  search: string,
  connector: {
    label: string;
    type: string;
    helpText?: string;
    tags?: readonly string[];
  },
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (connector.label.toLowerCase().includes(needle)) {
    return true;
  }
  if (connector.type.toLowerCase().includes(needle)) {
    return true;
  }
  if (connector.helpText?.toLowerCase().includes(needle)) {
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

export const allConnectorTypes$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogStatus$);
  const items = connectors.map(connectorCatalogStatusItemToConnectorType);

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
// Hidden connector types (removed from list by user; persisted in localStorage)
// ---------------------------------------------------------------------------

const hiddenConnectorTypes$ = computed((get): Set<ConnectorType> => {
  const raw = get(hiddenConnectorTypesRaw$);
  if (!raw) {
    return new Set();
  }
  return new Set(jsonParseOr<ConnectorType[]>(raw, []));
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

export const filteredConnectorTypes$ = computed(async (get) => {
  const keyword = get(connectorsSearch$);
  const effectiveFilter = get(connectorsConnectionFilter$);

  const agentEnabledTypes =
    effectiveFilter.kind === "agent"
      ? new Set(
          (await get(connectorAgentAuthorizations$)).find((row) => {
            return row.agent.id === effectiveFilter.agentId;
          })?.enabledTypes ?? [],
        )
      : null;

  const allConnectorTypes = await get(allConnectorTypes$);
  return allConnectorTypes.filter((connector) => {
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
      return agentEnabledTypes?.has(connector.type) ?? false;
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

const internalSelectedConnectorType$ = state<ConnectorType | null>(null);

type ActiveConnectorOAuthDeviceAuthState = {
  readonly connectorType: ConnectorType;
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
  readonly connectorType: ConnectorType;
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
      readonly connectorType: ConnectorType | null;
    }
  | {
      readonly status: "starting";
      readonly connectorType: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorOAuthDeviceAuthState & {
      readonly status: "pending" | "polling";
    })
  | {
      readonly status: "denied" | "expired" | "error";
      readonly connectorType: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

export type ConnectorExternalCodeState =
  | {
      readonly status: "idle";
      readonly connectorType: ConnectorType | null;
    }
  | {
      readonly status: "starting";
      readonly connectorType: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorExternalCodeState & {
      readonly status: "pending";
    })
  | {
      readonly status: "expired" | "error";
      readonly connectorType: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

type ConnectorConnectFlowState = {
  readonly type: ConnectorType;
  readonly id: string;
};

function createIdleConnectorOAuthDeviceAuthState(
  connectorType: ConnectorType | null = null,
): ConnectorOAuthDeviceAuthState {
  return { status: "idle", connectorType };
}

const internalConnectorOAuthDeviceAuthState$ =
  state<ConnectorOAuthDeviceAuthState>(
    createIdleConnectorOAuthDeviceAuthState(),
  );

function createIdleConnectorExternalCodeState(
  connectorType: ConnectorType | null = null,
): ConnectorExternalCodeState {
  return { status: "idle", connectorType };
}

const internalConnectorExternalCodeState$ = state<ConnectorExternalCodeState>(
  createIdleConnectorExternalCodeState(),
);
const resetConnectorOAuthDeviceAuthFlowSignal$ = resetSignal();
const resetConnectorExternalCodeFlowSignal$ = resetSignal();
const connectorOAuthDeviceAuthStartOptionValues$ = state<
  Record<string, Record<string, string>>
>({});

export const selectedConnectorType$ = computed((get) => {
  return get(internalSelectedConnectorType$);
});
export const setSelectedConnectorType$ = command(
  ({ get, set }, type: ConnectorType | null) => {
    set(internalSelectedConnectorType$, type);
    const deviceAuthCurrent = get(internalConnectorOAuthDeviceAuthState$);
    if (type !== deviceAuthCurrent.connectorType) {
      set(resetConnectorOAuthDeviceAuthFlowSignal$);
      set(
        internalConnectorOAuthDeviceAuthState$,
        createIdleConnectorOAuthDeviceAuthState(type),
      );
    }
    const externalCodeCurrent = get(internalConnectorExternalCodeState$);
    if (type !== externalCodeCurrent.connectorType) {
      set(resetConnectorExternalCodeFlowSignal$);
      set(
        internalConnectorExternalCodeState$,
        createIdleConnectorExternalCodeState(type),
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
  authCodeConnectorType,
  connectFlow,
  deviceAuthState,
  externalCodeState,
}: {
  readonly authCodeConnectorType: ConnectorType | null;
  readonly connectFlow: ConnectorConnectFlowState | null;
  readonly deviceAuthState: ConnectorOAuthDeviceAuthState;
  readonly externalCodeState: ConnectorExternalCodeState;
}): boolean {
  return (
    authCodeConnectorType !== null ||
    connectFlow !== null ||
    connectorOAuthDeviceAuthStateIsActive(deviceAuthState) ||
    connectorExternalCodeStateIsActive(externalCodeState)
  );
}

function connectorOAuthDeviceAuthStartOptionsKey(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): string {
  return `${type}:${authMethod}`;
}

export const connectorOAuthDeviceAuthStartOptionValuesFor$ = computed((get) => {
  const values = get(connectorOAuthDeviceAuthStartOptionValues$);
  return (type: ConnectorType, authMethod: ConnectorAuthMethodId) => {
    return (
      values[connectorOAuthDeviceAuthStartOptionsKey(type, authMethod)] ?? {}
    );
  };
});

export const setConnectorOAuthDeviceAuthStartOptionValue$ = command(
  (
    { get, set },
    args: {
      readonly type: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly name: string;
      readonly value: string;
    },
  ) => {
    const key = connectorOAuthDeviceAuthStartOptionsKey(
      args.type,
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

const internalScopeReviewType$ = state<ConnectorType | null>(null);
export const scopeReviewType$ = computed((get) => {
  return get(internalScopeReviewType$);
});

export const scopeDiff$ = computed(async (get) => {
  const type = get(internalScopeReviewType$);
  if (!type) {
    return null;
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroConnectorScopeDiffContract);
  const result = await accept(client.getScopeDiff({ params: { type } }), [200]);
  return result.body;
});

export const setScopeReviewType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalScopeReviewType$, type);
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
  ({ get, set }, type: string, name: string, value: string) => {
    const current = get(manualGrantFormValues$);
    set(manualGrantFormValues$, {
      ...current,
      [type]: { ...current[type], [name]: value },
    });
  },
);

export const clearManualGrantForm$ = command(({ get, set }, type: string) => {
  const current = get(manualGrantFormValues$);
  const updated = { ...current };
  delete updated[type];
  set(manualGrantFormValues$, updated);
});

export const manualGrantFormValuesFor$ = computed((get) => {
  const values = get(manualGrantFormValues$);
  return (type: string) => {
    return values[type] ?? {};
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

const finishConnectorConnection$ = command(
  (
    { get, set },
    type: ConnectorType,
    options: FinishConnectorConnectionOptions = {},
  ): boolean => {
    set(internalJustConnectedTypes$, (prev) => {
      return new Set([...prev, type]);
    });
    if (options.reloadConnectors !== false) {
      set(reloadConnectors$);
    }
    if (options.agentId) {
      set(reloadAgentConnectorAuthorizations$);
    }

    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.delete(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));

    if (options.toastMessage !== null) {
      toast.success(
        options.toastMessage ?? `${options.connectorLabel ?? type} connected`,
        {
          id: `connector-connected-${type}`,
        },
      );
    }
    if (options.clearSelectedConnector) {
      set(internalSelectedConnectorType$, null);
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// Submit manual connector grant command
// ---------------------------------------------------------------------------

type SubmitManualGrantParams = {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly inputValues: Record<string, string>;
  readonly options: PostConnectOptions;
};

export const submitManualGrant$ = command(
  async (
    { get, set },
    { type, authMethod, inputValues, options }: SubmitManualGrantParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorType: get(internalPollingOAuthAuthCodeConnectorType$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const connectorClient = createClient(zeroConnectorManualGrantContract);
        await accept(
          connectorClient.connect({
            params: { type },
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
        set(finishConnectorConnection$, type, {
          ...options,
          reloadConnectors: false,
          toastMessage: `${options.connectorLabel ?? type} connected successfully`,
        });
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
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

export const connectConnectorNoAuth$ = command(
  async (
    { get, set },
    { type, authMethod, options }: ConnectNoAuthParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorType: get(internalPollingOAuthAuthCodeConnectorType$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const connectorClient = createClient(zeroConnectorNoAuthGrantContract);
        await accept(
          connectorClient.connect({
            params: { type },
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
        set(finishConnectorConnection$, type, {
          ...options,
          reloadConnectors: false,
          toastMessage: `${options.connectorLabel ?? type} enabled successfully`,
        });
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

const internalPollingOAuthAuthCodeConnectorType$ = state<ConnectorType | null>(
  null,
);
const internalConnectFlowState$ = state<ConnectorConnectFlowState | null>(null);

export const pollingOAuthAuthCodeConnectorType$ = computed((get) => {
  return get(internalPollingOAuthAuthCodeConnectorType$);
});

export const pollingOAuthDeviceAuthConnectorType$ = computed((get) => {
  const current = get(internalConnectorOAuthDeviceAuthState$);
  return current.status === "pending" || current.status === "polling"
    ? current.connectorType
    : null;
});

export const connectFlowType$ = computed((get) => {
  return get(internalConnectFlowState$)?.type ?? null;
});

export const runConnectorConnectSuccess$ = command(
  async (
    { set },
    type: ConnectorType,
    onSuccess: () => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> => {
    const flow = createConnectorConnectFlowState(type);
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
// allConnectorTypes$ recomputation so the UI doesn't flash.
// ---------------------------------------------------------------------------

const internalJustConnectedTypes$ = state<Set<string>>(new Set());

/** Types that were just connected but may not yet be reflected in allConnectorTypes$. */
export const justConnectedTypes$ = computed((get) => {
  return get(internalJustConnectedTypes$);
});

/**
 * Disconnect a connector and clear its optimistic "just connected" flag.
 *
 * Without this cleanup, a connector that was connected earlier in the session
 * stays in the Connected section of /connectors after disconnect because the
 * optimistic override in allConnectorTypes$ wins over the fresh
 * `connected = false` from the API (regression #10272).
 */
export const disconnectConnector$ = command(
  async (
    { set },
    type: ConnectorType,
    connectorLabel: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(deleteConnector$, type, signal);
    signal.throwIfAborted();
    set(internalJustConnectedTypes$, (prev) => {
      if (!prev.has(type)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(type);
      return next;
    });
    toast.success(`${connectorLabel} disconnected`, {
      id: `connector-disconnected-${type}`,
    });
  },
);

function createConnectorConnectFlowState(
  type: ConnectorType,
): ConnectorConnectFlowState {
  return {
    type,
    id: `${type}-connect-${now()}-${Math.random().toString(36).slice(2)}`,
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
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly createClient: ZeroClientFactory;
  readonly options: PostConnectOptions;
};

type ConnectConnectorOAuthDeviceAuthParams = {
  readonly type: ConnectorType;
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

function createConnectorOAuthDeviceAuthRequestId(type: ConnectorType): string {
  return `${type}-oauth-device-${now()}-${Math.random().toString(36).slice(2)}`;
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
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorOAuthDeviceAuthState & {
  readonly status: "pending" | "polling";
} {
  return (
    (state.status === "pending" || state.status === "polling") &&
    state.connectorType === type &&
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
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorOAuthDeviceAuthState$);
    if (
      (current.status !== "pending" && current.status !== "polling") ||
      current.connectorType !== type ||
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
      type,
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
            type,
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
            params: { type, sessionId: current.sessionId },
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
            type,
            authMethod,
            requestId,
          )
        ) {
          return { stop: true };
        }

        if (pollResult.status === "complete") {
          signal.throwIfAborted();
          set(finishConnectorConnection$, type, {
            ...options,
            clearSelectedConnector: true,
            reloadConnectors: false,
          });
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
            connectorType: type,
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
      type,
      authMethod,
      requestId,
      createClient,
      options,
    }: PollConnectorOAuthDeviceAuthArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const client = createClient(zeroConnectorOauthDeviceAuthSessionContract, {
      apiBase: OAUTH_WEB_API_BASE,
    });
    const isCurrentRequest = (state: ConnectorOAuthDeviceAuthState) => {
      return isCurrentConnectorOAuthDeviceAuthRequest(
        state,
        type,
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
          { client, type, authMethod, requestId, options },
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
        connectorType: type,
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
    const { type, authMethod, options } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorType: get(internalPollingOAuthAuthCodeConnectorType$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorOAuthDeviceAuthRequestId(type);
        const flowSignal = set(
          resetConnectorOAuthDeviceAuthFlowSignal$,
          signal,
        );
        set(internalConnectorOAuthDeviceAuthState$, {
          status: "starting",
          connectorType: type,
          authMethod,
          requestId,
        });

        const createClient = get(zeroClient$);
        const client = createClient(
          zeroConnectorOauthDeviceAuthSessionContract,
          { apiBase: OAUTH_WEB_API_BASE },
        );
        const startResponse = await tapError(
          accept(
            client.create({
              params: { type },
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
            connectorType: type,
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
          connectorType: type,
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
            type,
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
            current.connectorType !== type ||
            (current.status !== "starting" &&
              current.status !== "pending" &&
              current.status !== "polling") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorOAuthDeviceAuthState(type);
        });
      },
    );
  },
);

export const connectConnectorOAuthDeviceAuthAndSettle$ = command(
  async (
    { set },
    args: {
      readonly type: ConnectorType;
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
        type: args.type,
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
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly agentId?: string;
};

type CompleteConnectorExternalCodeParams = {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

function createConnectorExternalCodeRequestId(type: ConnectorType): string {
  return `${type}-external-code-${now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentConnectorExternalCodeRequest(
  state: ConnectorExternalCodeState,
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorExternalCodeState & {
  readonly status: "pending";
} {
  return (
    state.status === "pending" &&
    state.connectorType === type &&
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
      readonly type: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly code: string;
    },
  ) => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorType !== args.type ||
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
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorType !== type ||
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
    const { type, authMethod } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorType: get(internalPollingOAuthAuthCodeConnectorType$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorExternalCodeRequestId(type);
        const flowSignal = set(resetConnectorExternalCodeFlowSignal$, signal);
        set(internalConnectorExternalCodeState$, {
          status: "starting",
          connectorType: type,
          authMethod,
          requestId,
        });

        const createClient = get(zeroClient$);
        const client = createClient(zeroConnectorExternalCodeSessionContract, {
          apiBase: OAUTH_WEB_API_BASE,
        });
        const startResponse = await tapError(
          accept(
            client.create({
              params: { type },
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
            connectorType: type,
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
          connectorType: type,
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
            current.connectorType !== type ||
            (current.status !== "starting" && current.status !== "pending") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorExternalCodeState(type);
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
    const { type, authMethod, options } = args;
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorType !== type ||
      current.authMethod !== authMethod
    ) {
      return false;
    }
    if (now() > current.expiresAtMs) {
      set(internalConnectorExternalCodeState$, {
        status: "expired",
        connectorType: type,
        authMethod,
        message: "Connection session expired. Start again to retry.",
      });
      return false;
    }

    const code = current.code.trim();
    if (!code) {
      set(internalConnectorExternalCodeState$, {
        ...current,
        errorMessage: `Enter the code from ${options.connectorLabel ?? type}.`,
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
          apiBase: OAUTH_WEB_API_BASE,
        });
        const completeResult = await accept(
          client.complete({
            params: { type, sessionId: current.sessionId },
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
            type,
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

        set(finishConnectorConnection$, type, {
          ...options,
          clearSelectedConnector: true,
          reloadConnectors: false,
        });
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
        type: args.type,
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

const resetOAuthAuthCodeConnectorLoopSignal$ = resetSignal();
const resetOAuthAuthCodeConnectorPopupSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

function connectorMatchesAuthMethod(
  connector: ConnectorResponse,
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return connector.type === type && connector.authMethod === authMethod;
}

function createConnectorOAuthAuthCodeChangedCommand(
  type: ConnectorType,
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
      return connectorMatchesAuthMethod(c, type, authMethod);
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
        authorization.body.enabledTypes.includes(type)
      );
    }
    return false;
  });
}

const openConnectorOAuthAuthCodeWindow$ = command(
  async (
    { get },
    args: {
      readonly type: ConnectorType;
      readonly method: ConnectorStatusAuthMethodDetail;
      readonly agentId: string | undefined;
      readonly beforeStart: (signal: AbortSignal) => Promise<void>;
    },
    signal: AbortSignal,
  ) => {
    const standalone = isStandaloneMode();

    // In standalone (PWA) mode, omit popup features so iOS Safari opens the
    // URL in the external browser instead of blocking it as a popup.
    const popupFeatures = standalone ? undefined : "width=600,height=700";
    const authWindow = window.open("about:blank", "_blank", popupFeatures);

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
            `${args.type}/${args.method.id} does not support browser authorization`,
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
                  params: { type: args.type },
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
                  apiBase: OAUTH_WEB_API_BASE,
                }).start({
                  params: { type: args.type },
                  body: {
                    authMethod: args.method.id,
                    authorizeAgent: true,
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
          authWindow.close();
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
    type: ConnectorType,
    method: ConnectorStatusAuthMethodDetail,
    options: PostConnectOptions,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorType: get(internalPollingOAuthAuthCodeConnectorType$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    set(internalPollingOAuthAuthCodeConnectorType$, type);

    return await withCleanup(
      (async () => {
        // Snapshot before starting the provider flow. The popup is already open
        // by the time this runs, so we keep browser popup blockers satisfied
        // while avoiding a race where a very fast callback completes before the
        // first poll baseline is captured.
        const onConnectorChanged$ = createConnectorOAuthAuthCodeChangedCommand(
          type,
          method.id,
          options.agentId,
        );
        const authWindow = await set(
          openConnectorOAuthAuthCodeWindow$,
          {
            type,
            method,
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
        const loopSignal = set(resetOAuthAuthCodeConnectorLoopSignal$, signal);
        const popupSignal = set(
          resetOAuthAuthCodeConnectorPopupSignal$,
          signal,
        );

        const completed = await withCleanup(
          (async () => {
            const waitForConnectorChanged = async () => {
              await set(
                setAblyLoop$,
                {
                  topic: "connector:changed",
                  loopCommand$: onConnectorChanged$,
                  options: { runOnSubscribe: true },
                },
                loopSignal,
              );
              return "connectorChanged" as const;
            };
            const changedPromise = waitForConnectorChanged();
            const waitResult =
              authWindow === null
                ? await changedPromise
                : await Promise.race([
                    changedPromise,
                    waitForOAuthAuthCodePopupClosed(authWindow, popupSignal),
                  ]);
            signal.throwIfAborted();

            if (waitResult === "popupClosed") {
              set(resetOAuthAuthCodeConnectorLoopSignal$, signal);
              const connectedAfterClose = await set(
                onConnectorChanged$,
                signal,
              );
              signal.throwIfAborted();
              if (!connectedAfterClose) {
                return false;
              }
            }
            return true;
          })(),
          () => {
            set(resetOAuthAuthCodeConnectorLoopSignal$, signal);
            set(resetOAuthAuthCodeConnectorPopupSignal$, signal);
          },
        );
        if (!completed) {
          return false;
        }

        // Refresh the connectors$ cache so UI picks up the latest state.
        set(reloadConnectors$);
        const { connectors } = await get(connectors$);
        signal.throwIfAborted();

        // Mark as optimistically connected before clearing polling so the UI
        // transitions directly from "Connecting…" to "Connected" without flash.
        const isConnected = connectors.some((c) => {
          return connectorMatchesAuthMethod(c, type, method.id);
        });
        if (isConnected) {
          set(finishConnectorConnection$, type, {
            ...options,
            clearSelectedConnector: true,
            reloadConnectors: false,
            toastMessage: null,
          });
        }
        return isConnected;
      })(),
      () => {
        set(internalPollingOAuthAuthCodeConnectorType$, (current) => {
          return current === type ? null : current;
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
      readonly type: ConnectorType;
      readonly method: ConnectorStatusAuthMethodDetail;
      readonly onSuccess: () => void | Promise<void>;
      readonly options: PostConnectOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      args.type,
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
