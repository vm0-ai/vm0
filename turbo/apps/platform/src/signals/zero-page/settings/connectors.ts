import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodType,
  type ConnectorBrowserVerificationCliAuthConnectorType,
  type ConnectorType,
  type ConnectorDisplayCategory,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  getApiTokenFieldStorageType,
  getAvailableConnectorAuthMethods,
  getConnectorAuthMethod,
  getConnectorCliAuthModes,
  hasRequiredScopes,
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
  zeroLocalBrowserConnectorContract,
  zeroConnectorsMainContract,
  zeroLocalAgentConnectorContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import type {
  ConnectorListResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import {
  connectors$,
  deleteConnector$,
  reloadConnectors$,
} from "../../external/connectors.ts";
import { resolveApiBaseForNavigation } from "../../api-base.ts";
import { zeroClient$, type ZeroClientFactory } from "../../api-client.ts";
import {
  jsonParseOr,
  onRef,
  resetSignal,
  settle,
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
const CONNECTOR_LIST_API_AUTH_METHOD_TYPES = [
  LOCAL_AGENT_CONNECTOR_TYPE,
  LOCAL_BROWSER_CONNECTOR_TYPE,
] as const satisfies readonly ConnectorType[];

type PostConnectOptions = {
  readonly showPermissionDialog?: boolean;
};

type StripeCliAuthMode = "test" | "live";

function isStripeCliAuthMode(value: string): value is StripeCliAuthMode {
  return value === "test" || value === "live";
}

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
  availableAuthMethods: ConnectorAuthMethodType[];
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
  const availableAuthMethods = getAvailableConnectorAuthMethods(
    params.type,
    params.features,
    {
      apiAuthMethodPolicy: {
        includeForTypes: CONNECTOR_LIST_API_AUTH_METHOD_TYPES,
      },
    },
  );
  const hasApiToken = availableAuthMethods.includes("api-token");
  const hasFeatureFlaggedMethod = availableAuthMethods.some((authMethod) => {
    return !!getConnectorAuthMethod(params.type, authMethod)?.featureFlag;
  });
  const connected = params.connector !== null;

  return {
    type: params.type,
    label:
      hasFeatureFlaggedMethod &&
      !hasApiToken &&
      !isHostBackedConnector(params.type)
        ? `[Experimental] ${config.label}`
        : config.label,
    helpText: config.helpText,
    category: config.category,
    tags: config.tags ?? [],
    connected,
    connector: params.connector,
    availableAuthMethods,
    scopeMismatch:
      !isHostBackedConnector(params.type) &&
      params.connector !== null &&
      params.connector.authMethod === "oauth" &&
      !hasRequiredScopes(params.type, params.connector.oauthScopes),
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
  const localAgentHostListPromise = get(localAgentHosts$);
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

  const items = (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => {
      return (
        getAvailableConnectorAuthMethods(type, features, {
          apiAuthMethodPolicy: {
            includeForTypes: CONNECTOR_LIST_API_AUTH_METHOD_TYPES,
          },
        }).length > 0
      );
    })
    .map((type) => {
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

export type ConnectorCliAuthState =
  | {
      readonly status: "idle";
      readonly connectorType: ConnectorType | null;
      readonly mode: string | null;
    }
  | {
      readonly status: "starting";
      readonly connectorType: ConnectorType;
      readonly mode: string | null;
      readonly requestId: string;
    }
  | {
      readonly status: "pending";
      readonly connectorType: ConnectorType;
      readonly mode: string | null;
      readonly requestId: string;
      readonly sessionToken: string;
      readonly browserUrl: string;
      readonly verificationText: string;
      readonly expiresAtMs: number;
      readonly pollIntervalMs: number;
      readonly approvalOpened: boolean;
      readonly errorMessage: string | null;
    }
  | {
      readonly status: "polling";
      readonly connectorType: ConnectorType;
      readonly mode: string | null;
      readonly requestId: string;
      readonly sessionToken: string;
      readonly browserUrl: string;
      readonly verificationText: string;
      readonly expiresAtMs: number;
      readonly pollIntervalMs: number;
      readonly approvalOpened: boolean;
      readonly errorMessage: string | null;
    }
  | {
      readonly status: "error";
      readonly connectorType: ConnectorType | null;
      readonly mode: string | null;
      readonly message: string;
    }
  | {
      readonly status: "expired";
      readonly connectorType: ConnectorType;
      readonly mode: string | null;
      readonly message: string;
    };

type ConnectorConnectFlowState = {
  readonly type: ConnectorType;
  readonly id: string;
};

function createIdleConnectorCliAuthState(
  connectorType: ConnectorType | null = null,
  mode: string | null = null,
): ConnectorCliAuthState {
  return { status: "idle", connectorType, mode };
}

const internalConnectorCliAuthState$ = state<ConnectorCliAuthState>(
  createIdleConnectorCliAuthState(),
);
const resetConnectorCliAuthFlowSignal$ = resetSignal();

export const selectedConnectorType$ = computed((get) => {
  return get(internalSelectedConnectorType$);
});
export const setSelectedConnectorType$ = command(
  ({ get, set }, type: ConnectorType | null) => {
    set(internalSelectedConnectorType$, type);
    const current = get(internalConnectorCliAuthState$);
    if (type !== current.connectorType) {
      set(resetConnectorCliAuthFlowSignal$);
      set(internalConnectorCliAuthState$, createIdleConnectorCliAuthState());
    }
  },
);

export const connectorCliAuthState$ = computed((get) => {
  return get(internalConnectorCliAuthState$);
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

// ---------------------------------------------------------------------------
// Submit API token command
// ---------------------------------------------------------------------------

export const submitApiToken$ = command(
  async (
    { get, set },
    type: ConnectorType,
    inputSecrets: Record<string, string>,
    options: PostConnectOptions,
    signal: AbortSignal,
  ) => {
    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const secretsClient = createClient(zeroSecretsContract);
        const variablesClient = createClient(zeroVariablesContract);
        const secrets = sanitizeTokenInputRecord(inputSecrets);
        for (const [name, value] of Object.entries(secrets)) {
          if (!value) {
            continue;
          }
          const isVariable =
            getApiTokenFieldStorageType(type, name) === "variable";
          if (isVariable) {
            await accept(
              variablesClient.set({
                body: { name, value },
                fetchOptions: { signal },
              }),
              [200, 201],
            );
          } else {
            await accept(
              secretsClient.set({
                body: { name, value },
                fetchOptions: { signal },
              }),
              [200, 201],
            );
          }
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        set(internalJustConnectedTypes$, (prev) => {
          return new Set([...prev, type]);
        });
        set(reloadConnectors$);
        // Show in connections list
        const hidden = new Set(get(hiddenConnectorTypes$));
        hidden.delete(type);
        set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
        toast.success(`${CONNECTOR_TYPES[type].label} connected successfully`, {
          id: `connector-connected-${type}`,
        });
        if (options.showPermissionDialog) {
          set(internalPermissionDialogType$, type);
        }
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

const internalPollingType$ = state<ConnectorType | null>(null);
const internalConnectFlowState$ = state<ConnectorConnectFlowState | null>(null);

export const pollingConnectorType$ = computed((get) => {
  return get(internalPollingType$);
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

        set(internalJustConnectedTypes$, (prev) => {
          return new Set([...prev, LOCAL_AGENT_CONNECTOR_TYPE]);
        });
        set(reloadConnectors$);
        set(reloadLocalAgentHosts$);

        const hidden = new Set(get(hiddenConnectorTypes$));
        hidden.delete(LOCAL_AGENT_CONNECTOR_TYPE);
        set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));

        toast.success(
          `${CONNECTOR_TYPES[LOCAL_AGENT_CONNECTOR_TYPE].label} connected`,
          {
            id: `connector-connected-${LOCAL_AGENT_CONNECTOR_TYPE}`,
          },
        );
        if (options.showPermissionDialog) {
          set(internalPermissionDialogType$, LOCAL_AGENT_CONNECTOR_TYPE);
        }
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

        set(internalJustConnectedTypes$, (prev) => {
          return new Set([...prev, LOCAL_BROWSER_CONNECTOR_TYPE]);
        });
        set(reloadConnectors$);
        set(reloadLocalBrowserHosts$);

        const hidden = new Set(get(hiddenConnectorTypes$));
        hidden.delete(LOCAL_BROWSER_CONNECTOR_TYPE);
        set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));

        toast.success(
          `${CONNECTOR_TYPES[LOCAL_BROWSER_CONNECTOR_TYPE].label} connected`,
          {
            id: `connector-connected-${LOCAL_BROWSER_CONNECTOR_TYPE}`,
          },
        );
        if (options.showPermissionDialog) {
          set(internalPermissionDialogType$, LOCAL_BROWSER_CONNECTOR_TYPE);
        }
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

// ---------------------------------------------------------------------------
// CLI auth browser-verification flow state
// ---------------------------------------------------------------------------

const CLI_AUTH_MIN_POLL_INTERVAL_MS = IN_VITEST ? 10 : 1000;

type CliAuthBrowserVerificationStartResult = {
  readonly mode: string | null;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly verificationText: string;
  readonly expiresInMs: number;
  readonly pollIntervalMs: number;
};

type CliAuthBrowserVerificationCompleteResult =
  | { readonly status: "pending"; readonly errorMessage: string | null }
  | { readonly status: "complete" };

type CliAuthBrowserVerificationAdapter = {
  readonly isMode: (mode: string) => boolean;
  readonly start: (args: {
    readonly createClient: ZeroClientFactory;
    readonly mode: string | null;
    readonly signal: AbortSignal;
  }) => Promise<CliAuthBrowserVerificationStartResult>;
  readonly complete: (args: {
    readonly createClient: ZeroClientFactory;
    readonly sessionToken: string;
    readonly signal: AbortSignal;
  }) => Promise<CliAuthBrowserVerificationCompleteResult>;
};

type PollConnectorCliAuthBrowserVerificationArgs = {
  readonly type: ConnectorType;
  readonly requestId: string;
  readonly adapter: CliAuthBrowserVerificationAdapter;
  readonly createClient: ZeroClientFactory;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly options: PostConnectOptions;
};

function secondsToMilliseconds(value: number): number {
  return Math.max(0, value * 1000);
}

const CLI_AUTH_BROWSER_VERIFICATION_ADAPTERS = {
  stripe: {
    isMode: isStripeCliAuthMode,
    start: async ({ createClient, mode, signal }) => {
      if (!mode || !isStripeCliAuthMode(mode)) {
        throw new Error("Select a valid CLI auth mode");
      }
      const client = createClient(zeroCliAuthStripeContract);
      const result = await accept(
        client.start({
          body: { mode },
          fetchOptions: { signal },
        }),
        [200],
      );
      return {
        mode: result.body.mode,
        sessionToken: result.body.sessionToken,
        browserUrl: result.body.browserUrl,
        verificationText: result.body.verificationCode,
        expiresInMs: secondsToMilliseconds(result.body.expiresIn),
        pollIntervalMs: secondsToMilliseconds(result.body.interval),
      };
    },
    complete: async ({ createClient, sessionToken, signal }) => {
      const client = createClient(zeroCliAuthStripeContract);
      const result = await accept(
        client.complete({
          body: { sessionToken },
          fetchOptions: { signal },
        }),
        [200],
        { toast: false },
      );
      if (result.body.status === "pending") {
        return {
          status: "pending",
          errorMessage: result.body.errorMessage,
        };
      }
      return { status: "complete" };
    },
  },
} satisfies Record<
  ConnectorBrowserVerificationCliAuthConnectorType,
  CliAuthBrowserVerificationAdapter
>;

function getCliAuthBrowserVerificationAdapter(
  type: ConnectorType,
): CliAuthBrowserVerificationAdapter | null {
  if (type in CLI_AUTH_BROWSER_VERIFICATION_ADAPTERS) {
    return CLI_AUTH_BROWSER_VERIFICATION_ADAPTERS[
      type as ConnectorBrowserVerificationCliAuthConnectorType
    ];
  }
  return null;
}

function createConnectorCliAuthRequestId(type: ConnectorType): string {
  return `${type}-cli-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createConnectorConnectFlowState(
  type: ConnectorType,
): ConnectorConnectFlowState {
  return {
    type,
    id: `${type}-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function userFacingConnectorCliAuthMessage(message: string): string {
  return message
    .replaceAll("Stripe CLI", "Stripe")
    .replaceAll("CLI auth", "connection")
    .replaceAll("cli auth", "connection");
}

function cliAuthErrorMessage(error: unknown): string {
  return error instanceof Error
    ? userFacingConnectorCliAuthMessage(error.message)
    : "Connection failed";
}

function isCurrentConnectorCliAuthRequest(
  state: ConnectorCliAuthState,
  type: ConnectorType,
  requestId: string,
): state is Extract<
  ConnectorCliAuthState,
  { readonly status: "pending" | "polling" }
> {
  return (
    (state.status === "pending" || state.status === "polling") &&
    state.connectorType === type &&
    state.requestId === requestId
  );
}

function getConnectorCliAuthMode(
  type: ConnectorType,
  state: ConnectorCliAuthState,
): string | null {
  return state.connectorType === type ? state.mode : null;
}

function connectorCliAuthRequiresMode(type: ConnectorType): boolean {
  return getConnectorCliAuthModes(type).length > 0;
}

function connectorCliAuthModeIsAllowed(
  type: ConnectorType,
  mode: string,
): boolean {
  const adapter = getCliAuthBrowserVerificationAdapter(type);
  return adapter?.isMode(mode) ?? false;
}

export const setConnectorCliAuthMode$ = command(
  ({ set }, type: ConnectorType, mode: string | null) => {
    if (mode !== null && !connectorCliAuthModeIsAllowed(type, mode)) {
      return;
    }
    set(resetConnectorCliAuthFlowSignal$);
    set(
      internalConnectorCliAuthState$,
      createIdleConnectorCliAuthState(type, mode),
    );
  },
);

export const clearConnectorCliAuth$ = command(({ set }) => {
  set(resetConnectorCliAuthFlowSignal$);
  set(internalConnectorCliAuthState$, createIdleConnectorCliAuthState());
});

const finishConnectorCliAuthConnection$ = command(
  ({ get, set }, type: ConnectorType, options: PostConnectOptions) => {
    set(internalJustConnectedTypes$, (prev) => {
      return new Set([...prev, type]);
    });
    set(reloadConnectors$);

    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.delete(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));

    toast.success(`${CONNECTOR_TYPES[type].label} connected`, {
      id: `connector-connected-${type}`,
    });
    if (options.showPermissionDialog) {
      set(internalPermissionDialogType$, type);
    }
    set(internalConnectorCliAuthState$, createIdleConnectorCliAuthState());
    return true;
  },
);

const pollConnectorCliAuthBrowserVerification$ = command(
  async (
    { get, set },
    {
      type,
      requestId,
      adapter,
      createClient,
      expiresAtMs,
      pollIntervalMs,
      options,
    }: PollConnectorCliAuthBrowserVerificationArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    while (Date.now() < expiresAtMs) {
      const latest = get(internalConnectorCliAuthState$);
      if (!isCurrentConnectorCliAuthRequest(latest, type, requestId)) {
        return false;
      }

      if (!latest.approvalOpened) {
        const remainingMs = expiresAtMs - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await delay(Math.min(CLI_AUTH_MIN_POLL_INTERVAL_MS, remainingMs), {
          signal,
        });
        signal.throwIfAborted();
        continue;
      }

      set(internalConnectorCliAuthState$, {
        ...latest,
        status: "polling",
      });

      const completeSettled = await settle(
        adapter.complete({
          createClient,
          sessionToken: latest.sessionToken,
          signal,
        }),
        signal,
      );
      const completeResult = completeSettled.ok
        ? completeSettled.value
        : {
            status: "error" as const,
            message: cliAuthErrorMessage(completeSettled.error),
          };

      const current = get(internalConnectorCliAuthState$);
      if (!isCurrentConnectorCliAuthRequest(current, type, requestId)) {
        return false;
      }

      if (completeResult.status === "complete") {
        return set(finishConnectorCliAuthConnection$, type, options);
      }

      if (completeResult.status === "error") {
        set(internalConnectorCliAuthState$, {
          status: "error",
          connectorType: type,
          mode: current.mode,
          message: completeResult.message,
        });
        return false;
      }

      set(internalConnectorCliAuthState$, {
        ...current,
        status: "pending",
        errorMessage: completeResult.errorMessage
          ? userFacingConnectorCliAuthMessage(completeResult.errorMessage)
          : null,
      });

      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await delay(Math.min(pollIntervalMs, remainingMs), {
        signal,
      });
      signal.throwIfAborted();
    }

    const latest = get(internalConnectorCliAuthState$);
    if (isCurrentConnectorCliAuthRequest(latest, type, requestId)) {
      set(internalConnectorCliAuthState$, {
        status: "expired",
        connectorType: type,
        mode: latest.mode,
        message: "Connection session expired. Start again to retry.",
      });
    }
    return false;
  },
);

export const openConnectorCliAuthApprovalPage$ = command(
  ({ get, set }, type: ConnectorType): boolean => {
    const current = get(internalConnectorCliAuthState$);
    if (
      (current.status !== "pending" && current.status !== "polling") ||
      current.connectorType !== type
    ) {
      return false;
    }

    const approvalWindow = window.open(current.browserUrl, "_blank");
    if (!approvalWindow) {
      set(internalConnectorCliAuthState$, {
        ...current,
        errorMessage: "Could not open the approval page. Try again.",
      });
      return false;
    }

    approvalWindow.opener = null;
    set(internalConnectorCliAuthState$, {
      ...current,
      approvalOpened: true,
      errorMessage: null,
    });
    return true;
  },
);

export const runConnectorCliAuth$ = command(
  async (
    { get, set },
    type: ConnectorType,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const adapter = getCliAuthBrowserVerificationAdapter(type);
    if (!adapter || get(internalSelectedConnectorType$) !== type) {
      return false;
    }

    const initialState = get(internalConnectorCliAuthState$);
    const selectedMode = getConnectorCliAuthMode(type, initialState);
    if (connectorCliAuthRequiresMode(type) && !selectedMode) {
      return false;
    }

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const requestId = createConnectorCliAuthRequestId(type);
        const flowSignal = set(resetConnectorCliAuthFlowSignal$, signal);
        set(internalConnectorCliAuthState$, {
          status: "starting",
          connectorType: type,
          mode: selectedMode,
          requestId,
        });

        const createClient = get(zeroClient$);
        const startSettled = await settle(
          adapter.start({
            createClient,
            mode: selectedMode,
            signal: flowSignal,
          }),
          flowSignal,
        );
        const startResult = startSettled.ok ? startSettled.value : null;
        if (!startSettled.ok && get(internalSelectedConnectorType$) === type) {
          set(internalConnectorCliAuthState$, {
            status: "error",
            connectorType: type,
            mode: selectedMode,
            message: cliAuthErrorMessage(startSettled.error),
          });
        }
        signal.throwIfAborted();
        if (!startResult || get(internalSelectedConnectorType$) !== type) {
          return false;
        }

        const expiresAtMs = Date.now() + startResult.expiresInMs;
        const pollIntervalMs = Math.max(
          startResult.pollIntervalMs,
          CLI_AUTH_MIN_POLL_INTERVAL_MS,
        );
        set(internalConnectorCliAuthState$, {
          status: "pending",
          connectorType: type,
          mode: startResult.mode,
          requestId,
          sessionToken: startResult.sessionToken,
          browserUrl: startResult.browserUrl,
          verificationText: startResult.verificationText,
          expiresAtMs,
          pollIntervalMs,
          approvalOpened: false,
          errorMessage: null,
        });

        return await set(
          pollConnectorCliAuthBrowserVerification$,
          {
            type,
            requestId,
            adapter,
            createClient,
            expiresAtMs,
            pollIntervalMs,
            options,
          },
          flowSignal,
        );
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
// Standalone mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the app is running as an installed PWA (standalone display mode).
 * In standalone mode, window.open() with popup features is blocked by iOS Safari.
 */
export function isStandaloneMode(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

const OAUTH_POPUP_CLOSED_POLL_MS = 250;

function waitForOAuthPopupClosed(
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

  intervalId = window.setInterval(checkClosed, OAUTH_POPUP_CLOSED_POLL_MS);
  signal.addEventListener("abort", onAbort, { once: true });
  checkClosed();

  return deferred.promise;
}

const resetOAuthConnectorLoopSignal$ = resetSignal();
const resetOAuthConnectorPopupSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

export const connectConnector$ = command(
  async (
    { get, set },
    type: ConnectorType,
    options: PostConnectOptions,
    signal: AbortSignal,
  ) => {
    const baseUrl = resolveApiBaseForNavigation(false);
    signal.throwIfAborted();

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    set(internalPollingType$, type);

    return await withCleanup(
      (async () => {
        const standalone = isStandaloneMode();

        // In standalone (PWA) mode, omit popup features so iOS Safari opens the
        // URL in the external browser instead of blocking it as a popup.
        const popupFeatures = standalone ? undefined : "width=600,height=700";
        const authWindow = window.open(
          `${baseUrl}/api/zero/connectors/${type}/authorize`,
          "_blank",
          popupFeatures,
        );

        if (!authWindow && !standalone) {
          throw new Error("Failed to open authorization window");
        }

        // Wait for the OAuth flow to complete. The callback publishes
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

        const loopSignal = set(resetOAuthConnectorLoopSignal$, signal);
        const popupSignal = set(resetOAuthConnectorPopupSignal$, signal);

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
                    waitForOAuthPopupClosed(authWindow, popupSignal),
                  ]);
            signal.throwIfAborted();

            if (waitResult === "popupClosed") {
              set(resetOAuthConnectorLoopSignal$, signal);
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
            set(resetOAuthConnectorLoopSignal$, signal);
            set(resetOAuthConnectorPopupSignal$, signal);
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
          set(internalJustConnectedTypes$, (prev) => {
            return new Set([...prev, type]);
          });
        }
        // Show in connections list again when user connects
        const hidden = new Set(get(hiddenConnectorTypes$));
        hidden.delete(type);
        set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
        // Close connect modal on OAuth success. Only connectors-page flows should
        // show the post-connect permission dialog.
        if (isConnected) {
          set(internalSelectedConnectorType$, null);
          if (options.showPermissionDialog) {
            set(internalPermissionDialogType$, type);
          }
        }
        return isConnected;
      })(),
      () => {
        set(internalPollingType$, (current) => {
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
// Connect via OAuth, then run onSuccess callback (settling phase)
// ---------------------------------------------------------------------------

export const connectAndSettle$ = command(
  async (
    { set },
    type: ConnectorType,
    onSuccess: () => void | Promise<void>,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(connectConnector$, type, options, signal);
    if (connected) {
      await onSuccess();
    }
  },
);
