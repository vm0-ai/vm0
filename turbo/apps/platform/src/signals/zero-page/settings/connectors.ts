import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAuthMethodId,
  type ConnectorType,
  type ConnectorDisplayCategory,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  getConnectorAuthMethod,
  connectorAuthMethodHasOAuthGrant,
  getConfiguredConnectorAuthMethods,
  getConnectorTags,
  hasRequiredScopes,
  isGoogleOAuthConnector,
  hasConnectorAuthCodeGrant,
  hasConnectorDeviceAuthGrant,
} from "@vm0/connectors/connector-utils";
import {
  zeroLocalAgentHostsContract,
  type LocalAgentHost,
  type LocalAgentHostListResponse,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import {
  zeroLocalBrowserDeviceClaimContract,
  zeroLocalBrowserHostsContract,
  type LocalBrowserHost,
  type LocalBrowserHostListResponse,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  zeroConnectorScopeDiffContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOauthStartContract,
  zeroConnectorApiTokenContract,
  zeroLocalBrowserConnectorContract,
  zeroConnectorsMainContract,
  zeroLocalAgentConnectorContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorListResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import {
  connectors$,
  deleteConnector$,
  reloadConnectors$,
} from "../../external/connectors.ts";
import { zeroClient$, type ZeroClientFactory } from "../../api-client.ts";
import {
  jsonParseOr,
  onRef,
  resetSignal,
  settle,
  setLoop,
  withCleanup,
} from "../../utils.ts";
import { setAblyLoop$ } from "../../realtime.ts";
import { localStorageSignals } from "../../external/local-storage.ts";
import { resetPermissionDialog$ } from "./permission-dialog.ts";
import { sanitizeTokenInputRecord } from "./token-input.ts";
import { IN_VITEST } from "../../../env.ts";

const HIDDEN_CONNECTIONS_STORAGE_KEY = "vm0.connections.hiddenTypes";
const { get$: hiddenConnectorTypesRaw$, set$: setHiddenConnectorTypes$ } =
  localStorageSignals(HIDDEN_CONNECTIONS_STORAGE_KEY);
export const LOCAL_AGENT_CONNECTOR_TYPE =
  "local-agent" as const satisfies ConnectorType;
export const LOCAL_BROWSER_CONNECTOR_TYPE =
  "local-browser" as const satisfies ConnectorType;
const LOCAL_AGENT_HOSTS_CHANGED_TOPIC = "local-agent:hosts-changed";
const LOCAL_BROWSER_HOSTS_CHANGED_TOPIC = "local-browser:hosts-changed";
const LOCAL_BROWSER_WEB_MESSAGE_SOURCE = "vm0-local-browser-web";
const LOCAL_BROWSER_EXTENSION_MESSAGE_SOURCE = "vm0-local-browser-extension";
const LOCAL_BROWSER_EXTENSION_DETECT_TIMEOUT_MS = 1000;
const LOCAL_BROWSER_EXTENSION_PAIR_TIMEOUT_MS = 10_000;
const CONNECTOR_LIST_MANAGED_AUTH_METHOD_TYPES = [
  LOCAL_AGENT_CONNECTOR_TYPE,
  LOCAL_BROWSER_CONNECTOR_TYPE,
] as const satisfies readonly ConnectorType[];

type PostConnectOptions = {
  readonly showPermissionDialog?: boolean;
};

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * All connector types with their connection status.
 * Merges the static CONNECTOR_TYPES registry with live data from the API.
 */
export interface ConnectorTypeWithStatus {
  type: ConnectorType;
  label: string;
  helpText: string;
  category: ConnectorDisplayCategory;
  /** Lowercase aliases/keywords used by connector search (from CONNECTOR_TYPES). */
  tags: readonly string[];
  connected: boolean;
  connector: ConnectorResponse | null;
  /** Auth methods available for this connector (considering feature flags). */
  availableAuthMethods: ConnectorAuthMethodId[];
  /** True if at least one agent references this connector (env mapping). */
  usedByAgent?: boolean;
  /** True if stored OAuth scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
  /** True if OAuth token refresh failed and user needs to reconnect. */
  needsReconnect: boolean;
  /** Online local-agent hosts for the virtual local-agent connector. */
  localAgentHosts?: LocalAgentHost[];
  /** Online local browser hosts for the virtual local-browser connector. */
  localBrowserHosts?: LocalBrowserHost[];
}

type ConnectorConnectLaunchMode = "oauth-auth-code" | "modal";

function getAvailableConnectorConnectAuthMethods(
  type: ConnectorType,
  featureStates: Record<string, boolean> | null | undefined,
  options: {
    readonly includeManagedForTypes: readonly ConnectorType[];
  },
): ConnectorAuthMethodId[] {
  return getConfiguredConnectorAuthMethods(type).filter((authMethod) => {
    const method = getConnectorAuthMethod(type, authMethod);
    switch (method?.grant.kind) {
      case "managed": {
        if (!options.includeManagedForTypes.includes(type)) {
          return false;
        }
        break;
      }
      case "auth-code":
      case "device-auth":
      case "manual": {
        break;
      }
      case undefined: {
        return false;
      }
    }
    return !method.featureFlag || !!featureStates?.[method.featureFlag];
  });
}

export function getConnectorConnectLaunchMode({
  type,
  availableAuthMethods,
  preferModalForGoogleOAuth = false,
}: {
  readonly type: ConnectorType;
  readonly availableAuthMethods: readonly ConnectorAuthMethodId[];
  readonly preferModalForGoogleOAuth?: boolean;
}): ConnectorConnectLaunchMode {
  const hasAuthCodeGrant = availableAuthMethods.some((authMethod) => {
    return getConnectorAuthMethod(type, authMethod)?.grant.kind === "auth-code";
  });
  if (!hasAuthCodeGrant) {
    return "modal";
  }
  if (!hasConnectorAuthCodeGrant(type)) {
    return "modal";
  }
  if (preferModalForGoogleOAuth && isGoogleOAuthConnector(type)) {
    return "modal";
  }
  return "oauth-auth-code";
}

const internalReloadLocalAgentHosts$ = state(0);
const internalReloadLocalBrowserHosts$ = state(0);

export function getLocalAgentOnlineHosts(
  hosts: readonly LocalAgentHost[],
): LocalAgentHost[] {
  return hosts.filter((host) => {
    return host.status === "online";
  });
}

export const localAgentHosts$ = computed(
  async (get): Promise<LocalAgentHostListResponse> => {
    get(internalReloadLocalAgentHosts$);

    const createClient = get(zeroClient$);
    const client = createClient(zeroLocalAgentHostsContract);
    const result = await accept(client.list(), [200]);
    return result.body as LocalAgentHostListResponse;
  },
);

export function getLocalBrowserOnlineHosts(
  hosts: readonly LocalBrowserHost[],
): LocalBrowserHost[] {
  return hosts.filter((host) => {
    return host.status === "online";
  });
}

export const localBrowserHosts$ = computed(
  async (get): Promise<LocalBrowserHostListResponse> => {
    get(internalReloadLocalBrowserHosts$);
    const features = await get(featureSwitch$);
    if (!features?.[FeatureSwitchKey.LocalBrowserUse]) {
      return { hosts: [] };
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroLocalBrowserHostsContract);
    const result = await accept(client.list(), [200]);
    return result.body as LocalBrowserHostListResponse;
  },
);

const reloadLocalAgentHosts$ = command(({ set }) => {
  set(internalReloadLocalAgentHosts$, (x) => {
    return x + 1;
  });
});

const reloadLocalBrowserHosts$ = command(({ set }) => {
  set(internalReloadLocalBrowserHosts$, (x) => {
    return x + 1;
  });
});

const reloadLocalAgentHostsFromRealtime$ = command(({ set }) => {
  set(reloadLocalAgentHosts$);
  return false;
});

const reloadLocalBrowserHostsFromRealtime$ = command(({ set }) => {
  set(reloadLocalBrowserHosts$);
  return false;
});

const watchLocalAgentHosts$ = command(async ({ set }, signal: AbortSignal) => {
  set(reloadLocalAgentHosts$);
  await set(
    setAblyLoop$,
    LOCAL_AGENT_HOSTS_CHANGED_TOPIC,
    reloadLocalAgentHostsFromRealtime$,
    signal,
  );
});

const watchLocalBrowserHosts$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(reloadLocalBrowserHosts$);
    await set(
      setAblyLoop$,
      LOCAL_BROWSER_HOSTS_CHANGED_TOPIC,
      reloadLocalBrowserHostsFromRealtime$,
      signal,
    );
  },
);

export const localAgentHostsWatcherRef$ = onRef(
  command(async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    await set(watchLocalAgentHosts$, signal);
  }),
);

function isLocalAgentConnector(type: ConnectorType): boolean {
  return type === LOCAL_AGENT_CONNECTOR_TYPE;
}

function isLocalBrowserConnector(type: ConnectorType): boolean {
  return type === LOCAL_BROWSER_CONNECTOR_TYPE;
}

function isHostBackedConnector(type: ConnectorType): boolean {
  return isLocalAgentConnector(type) || isLocalBrowserConnector(type);
}

function buildConnectorTypeStatus(params: {
  readonly type: ConnectorType;
  readonly connector: ConnectorResponse | null;
  readonly features: Record<string, boolean> | null | undefined;
  readonly localAgentOnlineHosts: LocalAgentHost[];
  readonly localBrowserOnlineHosts: LocalBrowserHost[];
}): ConnectorTypeWithStatus {
  const config = CONNECTOR_TYPES[params.type];
  const isLocalAgent = isLocalAgentConnector(params.type);
  const isLocalBrowser = isLocalBrowserConnector(params.type);
  const availableAuthMethods = getAvailableConnectorConnectAuthMethods(
    params.type,
    params.features,
    {
      includeManagedForTypes: CONNECTOR_LIST_MANAGED_AUTH_METHOD_TYPES,
    },
  );
  const hasManualCredentialGrant = availableAuthMethods.some((authMethod) => {
    return (
      getConnectorAuthMethod(params.type, authMethod)?.grant.kind === "manual"
    );
  });
  const showExperimentalLabel = availableAuthMethods.some((authMethod) => {
    const method = getConnectorAuthMethod(params.type, authMethod);
    return !!method?.featureFlag && method.showExperimentalLabel !== false;
  });
  const connected = params.connector !== null;
  const connectedAuthMethodHasOAuthGrant =
    params.connector !== null &&
    connectorAuthMethodHasOAuthGrant(params.type, params.connector.authMethod);
  const scopeMismatch =
    params.connector !== null &&
    connectedAuthMethodHasOAuthGrant &&
    !hasRequiredScopes(params.type, params.connector.oauthScopes);

  return {
    type: params.type,
    label:
      showExperimentalLabel &&
      !hasManualCredentialGrant &&
      !isHostBackedConnector(params.type)
        ? `[Experimental] ${config.label}`
        : config.label,
    helpText: config.helpText,
    category: config.category,
    tags: getConnectorTags(params.type),
    connected,
    connector: params.connector,
    availableAuthMethods,
    scopeMismatch: !isHostBackedConnector(params.type) && scopeMismatch,
    needsReconnect:
      !isHostBackedConnector(params.type) &&
      (params.connector?.needsReconnect ?? false),
    ...(isLocalAgent ? { localAgentHosts: params.localAgentOnlineHosts } : {}),
    ...(isLocalBrowser
      ? { localBrowserHosts: params.localBrowserOnlineHosts }
      : {}),
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
  const connectorListPromise = get(connectors$);
  const features = get(featureSwitch$);
  const localAgentHostListPromise = features?.[
    FeatureSwitchKey.LocalAgentConnector
  ]
    ? get(localAgentHosts$)
    : Promise.resolve({ hosts: [] } satisfies LocalAgentHostListResponse);
  const localBrowserHostListPromise = features?.[
    FeatureSwitchKey.LocalBrowserUse
  ]
    ? get(localBrowserHosts$)
    : Promise.resolve({ hosts: [] } satisfies LocalBrowserHostListResponse);

  const [{ connectors }, localAgentHostList, localBrowserHostList] =
    await Promise.all([
      connectorListPromise,
      localAgentHostListPromise,
      localBrowserHostListPromise,
    ]);
  const connectorMap = new Map(
    connectors.map((c) => {
      return [c.type, c];
    }),
  );
  const localAgentOnlineHosts = getLocalAgentOnlineHosts(
    localAgentHostList.hosts,
  );
  const localBrowserOnlineHosts = getLocalBrowserOnlineHosts(
    localBrowserHostList.hosts,
  );

  const items = CONNECTOR_TYPE_KEYS.filter((type) => {
    return (
      getAvailableConnectorConnectAuthMethods(type, features, {
        includeManagedForTypes: CONNECTOR_LIST_MANAGED_AUTH_METHOD_TYPES,
      }).length > 0
    );
  }).map((type) => {
    return buildConnectorTypeStatus({
      type,
      connector: connectorMap.get(type) ?? null,
      features,
      localAgentOnlineHosts,
      localBrowserOnlineHosts,
    });
  });

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

const internalConnectorsSearch$ = state("");
export const connectorsSearch$ = computed((get) => {
  return get(internalConnectorsSearch$);
});
export const setConnectorsSearch$ = command(({ set }, v: string) => {
  set(internalConnectorsSearch$, v);
});

// ---------------------------------------------------------------------------
// Selected connector for connect modal
// ---------------------------------------------------------------------------

const internalSelectedConnectorType$ = state<ConnectorType | null>(null);

type ActiveConnectorOAuthDeviceAuthState = {
  readonly connectorType: ConnectorType;
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

export type ConnectorOAuthDeviceAuthState =
  | {
      readonly status: "idle";
      readonly connectorType: ConnectorType | null;
    }
  | {
      readonly status: "starting";
      readonly connectorType: ConnectorType;
      readonly requestId: string;
    }
  | (ActiveConnectorOAuthDeviceAuthState & {
      readonly status: "pending" | "polling";
    })
  | {
      readonly status: "denied" | "expired" | "error";
      readonly connectorType: ConnectorType | null;
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
const resetConnectorOAuthDeviceAuthFlowSignal$ = resetSignal();

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
  },
);

export const connectorOAuthDeviceAuthState$ = computed((get) => {
  return get(internalConnectorOAuthDeviceAuthState$);
});

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
// Token form state (used by add-connection dialog)
// ---------------------------------------------------------------------------

const tokenFormValues$ = state<Record<string, Record<string, string>>>({});
export const tokenFormSubmitting$ = computed((get) => {
  return get(internalTokenFormSubmitting$);
});
const internalTokenFormSubmitting$ = state<string | null>(null);

export const setTokenFormValue$ = command(
  ({ get, set }, type: string, name: string, value: string) => {
    const current = get(tokenFormValues$);
    set(tokenFormValues$, {
      ...current,
      [type]: { ...current[type], [name]: value },
    });
  },
);

export const clearTokenForm$ = command(({ get, set }, type: string) => {
  const current = get(tokenFormValues$);
  const updated = { ...current };
  delete updated[type];
  set(tokenFormValues$, updated);
});

export const tokenFormValuesFor$ = (type: string) => {
  return computed((get) => {
    return get(tokenFormValues$)[type] ?? {};
  });
};

export const setTokenFormSubmitting$ = command(
  ({ set }, value: string | null) => {
    set(internalTokenFormSubmitting$, value);
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

    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.delete(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));

    if (options.toastMessage !== null) {
      toast.success(
        options.toastMessage ?? `${CONNECTOR_TYPES[type].label} connected`,
        {
          id: `connector-connected-${type}`,
        },
      );
    }
    if (options.showPermissionDialog) {
      set(internalPermissionDialogType$, type);
    }
    if (options.clearSelectedConnector) {
      set(internalSelectedConnectorType$, null);
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// Submit manual connector credentials command
// ---------------------------------------------------------------------------

type SubmitManualCredentialsParams = {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly inputSecrets: Record<string, string>;
  readonly options: PostConnectOptions;
};

export const submitManualCredentials$ = command(
  async (
    { get, set },
    { type, authMethod, inputSecrets, options }: SubmitManualCredentialsParams,
    signal: AbortSignal,
  ) => {
    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        if (authMethod !== "api-token") {
          throw new Error(`${type} ${authMethod} does not use API-token auth`);
        }
        const connectorClient = createClient(zeroConnectorApiTokenContract);
        await accept(
          connectorClient.connect({
            params: { type },
            body: { values: sanitizeTokenInputRecord(inputSecrets) },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        set(finishConnectorConnection$, type, {
          ...options,
          toastMessage: `${CONNECTOR_TYPES[type].label} connected successfully`,
        });
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

export type LocalBrowserExtensionStatus =
  | { readonly status: "unknown" }
  | { readonly status: "checking" }
  | {
      readonly status: "available";
      readonly browser?: string;
      readonly extensionVersion?: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "pairing" }
  | { readonly status: "error"; readonly message: string };

type LocalBrowserExtensionResponse =
  | {
      readonly type: "detected";
      readonly browser?: string;
      readonly extensionVersion?: string;
    }
  | {
      readonly type: "pairingStarted";
      readonly deviceCode: string;
      readonly userCode?: string;
    }
  | { readonly type: "error"; readonly message: string };

const internalLocalBrowserExtensionStatus$ = state<LocalBrowserExtensionStatus>(
  { status: "unknown" },
);

export const localBrowserExtensionStatus$ = computed((get) => {
  return get(internalLocalBrowserExtensionStatus$);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLocalBrowserExtensionResponse(
  data: unknown,
  requestId: string,
): LocalBrowserExtensionResponse | null {
  if (!isRecord(data)) {
    return null;
  }
  if (data.source !== LOCAL_BROWSER_EXTENSION_MESSAGE_SOURCE) {
    return null;
  }
  if (data.requestId !== requestId) {
    return null;
  }

  if (data.type === "vm0.localBrowser.detected") {
    return {
      type: "detected",
      browser: stringValue(data.browser),
      extensionVersion: stringValue(data.extensionVersion),
    };
  }

  if (data.type === "vm0.localBrowser.pairingStarted") {
    const deviceCode = stringValue(data.deviceCode);
    if (!deviceCode) {
      return {
        type: "error",
        message: "Local browser extension did not return a device code",
      };
    }
    return {
      type: "pairingStarted",
      deviceCode,
      userCode: stringValue(data.userCode),
    };
  }

  if (data.type === "vm0.localBrowser.error") {
    return {
      type: "error",
      message: stringValue(data.message) ?? "Local browser extension failed",
    };
  }

  return null;
}

function createLocalBrowserRequestId(): string {
  return `local-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendLocalBrowserExtensionRequest(
  type: "detect" | "pair",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<LocalBrowserExtensionResponse> {
  signal.throwIfAborted();

  const requestId = createLocalBrowserRequestId();
  const deferred = Promise.withResolvers<LocalBrowserExtensionResponse>();
  let settled = false;
  let timeoutId: ReturnType<typeof window.setTimeout> | undefined;

  function cleanup() {
    window.removeEventListener("message", onMessage);
    signal.removeEventListener("abort", onAbort);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  }

  function resolve(response: LocalBrowserExtensionResponse) {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (response.type === "error") {
      deferred.reject(new Error(response.message));
      return;
    }
    deferred.resolve(response);
  }

  function reject(error: unknown) {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    deferred.reject(error);
  }

  function onAbort() {
    reject(signal.reason);
  }

  function onMessage(event: MessageEvent<unknown>) {
    if (event.source && event.source !== window) {
      return;
    }
    if (event.origin && event.origin !== window.location.origin) {
      return;
    }
    const response = parseLocalBrowserExtensionResponse(event.data, requestId);
    if (!response) {
      return;
    }
    resolve(response);
  }

  window.addEventListener("message", onMessage);
  signal.addEventListener("abort", onAbort, { once: true });
  timeoutId = window.setTimeout(() => {
    reject(new Error("Local browser extension did not respond"));
  }, timeoutMs);
  window.postMessage(
    {
      source: LOCAL_BROWSER_WEB_MESSAGE_SOURCE,
      type: `vm0.localBrowser.${type}`,
      requestId,
    },
    window.location.origin,
  );

  return deferred.promise;
}

function localBrowserErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Local browser extension pairing failed";
}

export const detectLocalBrowserExtension$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    set(internalLocalBrowserExtensionStatus$, { status: "checking" });
    const [result] = await Promise.allSettled([
      sendLocalBrowserExtensionRequest(
        "detect",
        LOCAL_BROWSER_EXTENSION_DETECT_TIMEOUT_MS,
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (result.status === "rejected") {
      set(internalLocalBrowserExtensionStatus$, {
        status: "missing",
      });
      return;
    }

    const response = result.value;
    if (response.type !== "detected") {
      set(internalLocalBrowserExtensionStatus$, {
        status: "error",
        message: "Unexpected local browser extension response",
      });
      return;
    }
    set(internalLocalBrowserExtensionStatus$, {
      status: "available",
      browser: response.browser,
      extensionVersion: response.extensionVersion,
    });
  },
);

export const pairLocalBrowserExtension$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(internalLocalBrowserExtensionStatus$, { status: "pairing" });
    const [result] = await Promise.allSettled([
      sendLocalBrowserExtensionRequest(
        "pair",
        LOCAL_BROWSER_EXTENSION_PAIR_TIMEOUT_MS,
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (result.status === "rejected") {
      const message = localBrowserErrorMessage(result.reason);
      if (message.includes("did not respond")) {
        set(internalLocalBrowserExtensionStatus$, { status: "missing" });
      } else {
        set(internalLocalBrowserExtensionStatus$, {
          status: "error",
          message,
        });
      }
      toast.error(message, { id: "local-browser-extension-pair-error" });
      throw result.reason;
    }

    const response = result.value;
    if (response.type !== "pairingStarted") {
      const message = "Unexpected local browser extension response";
      set(internalLocalBrowserExtensionStatus$, {
        status: "error",
        message,
      });
      toast.error(message, { id: "local-browser-extension-pair-error" });
      throw new Error(message);
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroLocalBrowserDeviceClaimContract, {
      apiBase: "api",
    });
    const [claimResult] = await Promise.allSettled([
      accept(
        client.claim({
          body: { deviceCode: response.deviceCode },
          fetchOptions: { signal },
        }),
        [200],
      ),
    ]);
    signal.throwIfAborted();
    if (claimResult.status === "rejected") {
      const message = localBrowserErrorMessage(claimResult.reason);
      set(internalLocalBrowserExtensionStatus$, {
        status: "error",
        message,
      });
      toast.error(message, { id: "local-browser-extension-pair-error" });
      throw claimResult.reason;
    }

    set(reloadLocalBrowserHosts$);
    set(internalLocalBrowserExtensionStatus$, { status: "available" });
    toast.success("Browser extension paired", {
      id: "local-browser-extension-paired",
    });
  },
);

export const localBrowserConnectionRef$ = onRef(
  command(async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    set(reloadLocalBrowserHosts$);
    await set(detectLocalBrowserExtension$, signal);
    await set(watchLocalBrowserHosts$, signal);
  }),
);

export const connectLocalAgentConnector$ = command(
  async (
    { get, set },
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const flow = createConnectorConnectFlowState(LOCAL_AGENT_CONNECTOR_TYPE);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const client = createClient(zeroLocalAgentConnectorContract, {
          apiBase: "api",
        });
        await accept(
          client.create({
            body: {},
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();

        set(reloadLocalAgentHosts$);
        set(finishConnectorConnection$, LOCAL_AGENT_CONNECTOR_TYPE, options);
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

export const connectLocalBrowserConnector$ = command(
  async (
    { get, set },
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const flow = createConnectorConnectFlowState(LOCAL_BROWSER_CONNECTOR_TYPE);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const client = createClient(zeroLocalBrowserConnectorContract, {
          apiBase: "api",
        });
        await accept(
          client.create({
            body: {},
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();

        set(reloadLocalBrowserHosts$);
        set(finishConnectorConnection$, LOCAL_BROWSER_CONNECTOR_TYPE, options);
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

export const deleteLocalBrowserHost$ = command(
  async ({ get, set }, hostId: string, signal: AbortSignal): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroLocalBrowserHostsContract);
    await accept(
      client.delete({
        params: { hostId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadLocalBrowserHosts$);
    toast.success("Browser host removed", {
      id: `local-browser-host-removed-${hostId}`,
    });
  },
);

/**
 * Disconnect a connector and clear its optimistic "just connected" flag.
 *
 * Without this cleanup, a connector that was connected earlier in the session
 * stays in the Connected section of /connectors after disconnect because the
 * optimistic override in allConnectorTypes$ wins over the fresh
 * `connected = false` from the API (regression #10272).
 */
export const disconnectConnector$ = command(
  async ({ set }, type: ConnectorType, signal: AbortSignal): Promise<void> => {
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
    toast.success(`${CONNECTOR_TYPES[type].label} disconnected`, {
      id: `connector-disconnected-${type}`,
    });
  },
);

// ---------------------------------------------------------------------------
// Post-connect permission dialog state
// ---------------------------------------------------------------------------

const internalPermissionDialogType$ = state<ConnectorType | null>(null);

/** Connector type to show the permission dialog for (null = hidden). */
export const permissionDialogType$ = computed((get) => {
  return get(internalPermissionDialogType$);
});

export const setPermissionDialogType$ = command(
  ({ set }, type: ConnectorType | null) => {
    if (type !== null) {
      set(resetPermissionDialog$);
    }
    set(internalPermissionDialogType$, type);
  },
);

function createConnectorConnectFlowState(
  type: ConnectorType,
): ConnectorConnectFlowState {
  return {
    type,
    id: `${type}-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  readonly requestId: string;
  readonly createClient: ZeroClientFactory;
  readonly options: PostConnectOptions;
};

function createConnectorOAuthDeviceAuthRequestId(type: ConnectorType): string {
  return `${type}-oauth-device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function oauthDeviceAuthErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed";
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
  requestId: string,
): state is ActiveConnectorOAuthDeviceAuthState & {
  readonly status: "pending" | "polling";
} {
  return (
    (state.status === "pending" || state.status === "polling") &&
    state.connectorType === type &&
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
  ({ get, set }, type: ConnectorType): boolean => {
    const current = get(internalConnectorOAuthDeviceAuthState$);
    if (
      (current.status !== "pending" && current.status !== "polling") ||
      current.connectorType !== type
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

const pollConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    {
      type,
      requestId,
      createClient,
      options,
    }: PollConnectorOAuthDeviceAuthArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const client = createClient(zeroConnectorOauthDeviceAuthSessionContract);
    let completed = false;
    let expired = false;

    await setLoop(
      async (sig) => {
        const current = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(current, type, requestId)
        ) {
          return true;
        }

        const remainingMs = current.expiresAtMs - Date.now();
        if (remainingMs <= 0) {
          expired = true;
          return true;
        }

        if (!current.approvalOpened) {
          await delay(
            Math.min(OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS, remainingMs),
            { signal: sig },
          );
          sig.throwIfAborted();
          return false;
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          ...current,
          status: "polling",
        });

        const pollSettled = await settle(
          accept(
            client.poll({
              params: { type, sessionId: current.sessionId },
              body: { sessionToken: current.sessionToken },
              fetchOptions: { signal: sig },
            }),
            [200],
            { toast: false },
          ),
          sig,
        );
        const pollResult = pollSettled.ok
          ? pollSettled.value.body
          : {
              status: "error" as const,
              errorMessage: oauthDeviceAuthErrorMessage(pollSettled.error),
            };

        const latest = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(latest, type, requestId)
        ) {
          return true;
        }

        if (pollResult.status === "complete") {
          set(finishConnectorConnection$, type, {
            ...options,
            clearSelectedConnector: true,
          });
          set(
            internalConnectorOAuthDeviceAuthState$,
            createIdleConnectorOAuthDeviceAuthState(),
          );
          completed = true;
          return true;
        }

        if (pollResult.status !== "pending") {
          set(internalConnectorOAuthDeviceAuthState$, {
            status: pollResult.status,
            connectorType: type,
            message: getOAuthDeviceAuthTerminalMessage(pollResult),
          });
          return true;
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

        const nextRemainingMs = latest.expiresAtMs - Date.now();
        if (nextRemainingMs <= 0) {
          expired = true;
          return true;
        }
        await delay(Math.min(pollIntervalMs, nextRemainingMs), { signal: sig });
        sig.throwIfAborted();
        return false;
      },
      0,
      signal,
    );

    const latest = get(internalConnectorOAuthDeviceAuthState$);
    if (
      expired &&
      isCurrentConnectorOAuthDeviceAuthRequest(latest, type, requestId)
    ) {
      set(internalConnectorOAuthDeviceAuthState$, {
        status: "expired",
        connectorType: type,
        message: "Connection session expired. Start again to retry.",
      });
    }
    return completed;
  },
);

export const connectConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    type: ConnectorType,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!hasConnectorDeviceAuthGrant(type)) {
      throw new Error(`${type} does not use device authorization OAuth`);
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
          requestId,
        });

        const createClient = get(zeroClient$);
        const client = createClient(
          zeroConnectorOauthDeviceAuthSessionContract,
        );
        const startSettled = await settle(
          accept(
            client.create({
              params: { type },
              body: {},
              fetchOptions: { signal: flowSignal },
            }),
            [200],
            { toast: false },
          ),
          flowSignal,
        );
        const startResult = startSettled.ok ? startSettled.value.body : null;
        if (!startSettled.ok) {
          if (flowSignal.aborted) {
            return false;
          }
          set(internalConnectorOAuthDeviceAuthState$, {
            status: "error",
            connectorType: type,
            message: oauthDeviceAuthErrorMessage(startSettled.error),
          });
        }
        flowSignal.throwIfAborted();
        if (!startResult) {
          return false;
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          status: "pending",
          connectorType: type,
          requestId,
          sessionId: startResult.sessionId,
          sessionToken: startResult.sessionToken,
          userCode: startResult.userCode,
          verificationUri: startResult.verificationUri,
          verificationUriComplete: startResult.verificationUriComplete,
          expiresAtMs:
            Date.now() + secondsToMilliseconds(startResult.expiresIn),
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
            !signal.aborted ||
            requestId === null ||
            current.connectorType !== type ||
            (current.status !== "starting" &&
              current.status !== "pending" &&
              current.status !== "polling") ||
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
    type: ConnectorType,
    onSuccess: () => void | Promise<void>,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthDeviceAuth$,
      type,
      options,
      signal,
    );
    if (connected) {
      await onSuccess();
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

const OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS = 250;

function waitForOAuthAuthCodePopupClosed(
  authWindow: Pick<Window, "closed">,
  signal: AbortSignal,
): Promise<"popupClosed"> {
  signal.throwIfAborted();

  const deferred = Promise.withResolvers<"popupClosed">();
  let settled = false;
  let intervalId: ReturnType<typeof window.setInterval> | undefined;

  function cleanup() {
    if (intervalId !== undefined) {
      window.clearInterval(intervalId);
      intervalId = undefined;
    }
    signal.removeEventListener("abort", onAbort);
  }

  function resolveClosed() {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    deferred.resolve("popupClosed");
  }

  function rejectAborted() {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    deferred.reject(signal.reason);
  }

  function onAbort() {
    rejectAborted();
  }

  function checkClosed() {
    if (authWindow.closed) {
      resolveClosed();
    }
  }

  intervalId = window.setInterval(
    checkClosed,
    OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS,
  );
  signal.addEventListener("abort", onAbort, { once: true });
  checkClosed();

  return deferred.promise;
}

const resetOAuthAuthCodeConnectorLoopSignal$ = resetSignal();
const resetOAuthAuthCodeConnectorPopupSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

function assertConnectorUsesOAuthAuthCode(type: ConnectorType): void {
  if (!hasConnectorAuthCodeGrant(type)) {
    throw new Error(`${type} does not use authorization-code OAuth`);
  }
}

const openConnectorOAuthAuthCodeWindow$ = command(
  async ({ get }, type: ConnectorType, signal: AbortSignal) => {
    assertConnectorUsesOAuthAuthCode(type);

    const standalone = isStandaloneMode();

    // In standalone (PWA) mode, omit popup features so iOS Safari opens the
    // URL in the external browser instead of blocking it as a popup.
    const popupFeatures = standalone ? undefined : "width=600,height=700";
    const authWindow = window.open("about:blank", "_blank", popupFeatures);

    if (!authWindow && !standalone) {
      throw new Error("Failed to open authorization window");
    }

    const startClient = get(zeroClient$)(zeroConnectorOauthStartContract, {
      apiBase: "www",
    });
    const startResult = await accept(
      startClient.start({
        params: { type },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    if (authWindow) {
      authWindow.location.href = startResult.body.authorizationUrl;
    } else if (standalone) {
      window.location.href = startResult.body.authorizationUrl;
    }

    return authWindow;
  },
);

export const connectConnectorOAuthAuthCode$ = command(
  async (
    { get, set },
    type: ConnectorType,
    options: PostConnectOptions,
    signal: AbortSignal,
  ) => {
    assertConnectorUsesOAuthAuthCode(type);

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    set(internalPollingOAuthAuthCodeConnectorType$, type);

    return await withCleanup(
      (async () => {
        const authWindow = await set(
          openConnectorOAuthAuthCodeWindow$,
          type,
          signal,
        );
        signal.throwIfAborted();

        // Wait for the auth-code OAuth flow to complete. The callback publishes
        // `connector:changed`, and the subscription rechecks the server state.
        // Snapshot taken on the first body invocation: `null` marks "no
        // connector yet" and an `updatedAt` value marks "reconnect scenario —
        // wait for it to change". The snapshot must happen *inside* the loop
        // body so we start from the freshest server state, not a cached signal
        // value.
        let initialUpdatedAt: string | null | undefined;

        const onConnectorChanged$ = command(
          async ({ get }, sig: AbortSignal): Promise<boolean> => {
            const client = get(zeroClient$)(zeroConnectorsMainContract);
            const result = await accept(
              client.list({ fetchOptions: { signal: sig } }),
              [200],
            );
            const polled = (result.body as ConnectorListResponse).connectors;
            const current = polled.find((c) => {
              return c.type === type;
            });

            if (initialUpdatedAt === undefined) {
              initialUpdatedAt = current?.updatedAt ?? null;
              return false;
            }
            if (current) {
              // initialUpdatedAt === null means the connector didn't exist on
              // the first fetch; any subsequent appearance signals completion.
              if (initialUpdatedAt === null) {
                return true;
              }
              if (current.updatedAt !== initialUpdatedAt) {
                return true;
              }
            }
            return false;
          },
        );

        // Prime once so `initialUpdatedAt` snapshots the current server state.
        // `setAblyLoop$` no longer primes its subscribers, and without this the
        // first ably event would be taken as the baseline instead of signalling
        // completion.
        await set(onConnectorChanged$, signal);
        signal.throwIfAborted();

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
                "connector:changed",
                onConnectorChanged$,
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
          return c.type === type;
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
// Connect via auth-code OAuth, then run onSuccess callback (settling phase)
// ---------------------------------------------------------------------------

export const connectConnectorOAuthAuthCodeAndSettle$ = command(
  async (
    { set },
    type: ConnectorType,
    onSuccess: () => void | Promise<void>,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      type,
      options,
      signal,
    );
    if (connected) {
      await onSuccess();
    }
  },
);
