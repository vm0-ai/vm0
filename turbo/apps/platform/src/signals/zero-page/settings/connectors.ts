import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
  type ConnectorDisplayCategory,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethod,
  getConfiguredConnectorAuthMethodIds,
  getConnectorTags,
  hasRequiredConnectorAuthMethodScopes,
  hasConnectorDeviceAuthGrant,
} from "@vm0/connectors/connector-utils";
import { shouldShowGoogleSecurityWarningNotice } from "../../../lib/google-security-warning.ts";
import {
  zeroConnectorScopeDiffContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOauthStartContract,
  zeroConnectorManualGrantContract,
  zeroConnectorsMainContract,
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
type PostConnectOptions = {
  readonly showPermissionDialog?: boolean;
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
  /** True if stored grant scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
  /** User-facing connection state derived from API state and scope coverage. */
  connectionStatus: ConnectorConnectionStatus;
  /** Stored credential expiry returned by the API. */
  tokenExpiresAt: string | null;
  /** True when the selected auth method can refresh runtime access. */
  authMethodSupportsRefresh: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ConnectorConnectLaunchMode = "oauth-auth-code" | "modal";

function getAvailableConnectorConnectAuthMethods(
  type: ConnectorType,
  featureStates: Record<string, boolean> | null | undefined,
  options: {
    readonly includeManagedForTypes: readonly ConnectorType[];
  },
): ConnectorAuthMethodId[] {
  return getConfiguredConnectorAuthMethodIds(type).filter((authMethod) => {
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
  preferModalForGoogleSecurityWarning = false,
}: {
  readonly type: ConnectorType;
  readonly availableAuthMethods: readonly ConnectorAuthMethodId[];
  readonly preferModalForGoogleSecurityWarning?: boolean;
}): ConnectorConnectLaunchMode {
  const [authMethod] = availableAuthMethods;
  if (availableAuthMethods.length !== 1 || !authMethod) {
    return "modal";
  }
  if (getConnectorAuthMethod(type, authMethod)?.grant.kind !== "auth-code") {
    return "modal";
  }
  if (
    preferModalForGoogleSecurityWarning &&
    shouldShowGoogleSecurityWarningNotice(type)
  ) {
    return "modal";
  }
  return "oauth-auth-code";
}

export function getAvailableAuthCodeAuthMethod(
  type: ConnectorType,
  availableAuthMethods: readonly ConnectorAuthMethodId[],
  authMethod: string,
): ConnectorAuthMethodId | null {
  const authMethodResult = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!authMethodResult.success) {
    return null;
  }
  if (!availableAuthMethods.includes(authMethodResult.data)) {
    return null;
  }
  if (
    getConnectorAuthMethod(type, authMethodResult.data)?.grant.kind !==
    "auth-code"
  ) {
    return null;
  }
  return authMethodResult.data;
}

export function getOnlyAvailableAuthCodeAuthMethod(
  type: ConnectorType,
  availableAuthMethods: readonly ConnectorAuthMethodId[],
): ConnectorAuthMethodId | null {
  const [authMethod] = availableAuthMethods;
  if (availableAuthMethods.length !== 1 || !authMethod) {
    return null;
  }
  return getAvailableAuthCodeAuthMethod(type, availableAuthMethods, authMethod);
}

function connectorAuthMethodSupportsRefresh(
  type: ConnectorType,
  authMethod: string,
): boolean {
  return (
    getConnectorAuthMethodAccessMetadata(type, authMethod)?.kind ===
    "refresh-token"
  );
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
  nowMs = Date.now(),
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
  nowMs = Date.now(),
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

function buildConnectorTypeStatus(params: {
  readonly type: ConnectorType;
  readonly connector: ConnectorResponse | null;
  readonly features: Record<string, boolean> | null | undefined;
}): ConnectorTypeWithStatus {
  const config = CONNECTOR_TYPES[params.type];
  const availableAuthMethods = getAvailableConnectorConnectAuthMethods(
    params.type,
    params.features,
    {
      includeManagedForTypes: [],
    },
  );
  const hasManualGrant = availableAuthMethods.some((authMethod) => {
    return (
      getConnectorAuthMethod(params.type, authMethod)?.grant.kind === "manual"
    );
  });
  const showExperimentalLabel = availableAuthMethods.some((authMethod) => {
    const method = getConnectorAuthMethod(params.type, authMethod);
    return !!method?.featureFlag && method.showExperimentalLabel !== false;
  });
  const connected = params.connector !== null;
  const apiConnectionStatus = params.connector?.connectionStatus ?? null;
  const authMethodSupportsRefresh =
    params.connector !== null &&
    connectorAuthMethodSupportsRefresh(
      params.type,
      params.connector.authMethod,
    );
  const scopeMismatch =
    params.connector !== null &&
    !hasRequiredConnectorAuthMethodScopes(
      params.type,
      params.connector.authMethod,
      params.connector.oauthScopes,
    );
  let connectionStatus: ConnectorConnectionStatus = "not-connected";
  if (params.connector !== null) {
    connectionStatus = "connected";
    if (apiConnectionStatus === "reconnect-required") {
      connectionStatus = "reconnect-required";
    } else if (scopeMismatch) {
      connectionStatus = "scope-mismatch";
    }
  }

  return {
    type: params.type,
    label:
      showExperimentalLabel && !hasManualGrant
        ? `[Experimental] ${config.label}`
        : config.label,
    helpText: config.helpText,
    category: config.category,
    tags: getConnectorTags(params.type),
    connected,
    connector: params.connector,
    availableAuthMethods,
    scopeMismatch,
    connectionStatus,
    tokenExpiresAt: params.connector?.tokenExpiresAt ?? null,
    authMethodSupportsRefresh,
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
  const { connectors } = await connectorListPromise;
  const connectorMap = new Map(
    connectors.map((c) => {
      return [c.type, c];
    }),
  );

  const items = CONNECTOR_TYPE_KEYS.filter((type) => {
    return (
      getAvailableConnectorConnectAuthMethods(type, features, {
        includeManagedForTypes: [],
      }).length > 0
    );
  }).map((type) => {
    return buildConnectorTypeStatus({
      type,
      connector: connectorMap.get(type) ?? null,
      features,
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
// Onboarding connector curation
//
// The onboarding picker used to render the entire connector catalog (200+),
// which buries the handful of tools real teams actually use. We curate it to
// two sources: connectors external teams have actually connected (from a
// masked production snapshot) plus a short list of famous tools. The full
// catalog stays available from the connectors page after onboarding.
// ---------------------------------------------------------------------------

/**
 * Connector types external (non-vm0) teams have actually connected, ordered by
 * adoption (distinct external orgs). Generated from a masked production
 * snapshot on 2026-05-30; refresh periodically against mask-db.
 */
const EXTERNAL_ADOPTED_ONBOARDING_TYPES: readonly string[] = [
  "github",
  "gmail",
  "notion",
  "x",
  "slack",
  "google-drive",
  "google-calendar",
  "google-sheets",
  "agentmail",
  "openai",
  "cloudflare",
  "deepseek",
  "discord",
  "intervals-icu",
  "lark",
  "google-docs",
  "linear",
  "serpapi",
  "strava",
  "tavily",
  "vercel",
  "discord-webhook",
  "e2b",
  "exa",
  "figma",
  "groq",
  "hugging-face",
  "minimax",
  "apify",
  "base44",
  "browser-use",
  "browserless",
  "clickup",
  "db9",
  "drive9",
  "dropbox",
  "elevenlabs",
  "fal",
  "firecrawl",
  "google-ads",
  "google-meet",
  "heygen",
  "hubspot",
  "jira",
  "luma",
  "luma-ai",
  "mem0",
  "neon",
  "openweather",
  "pdf4me",
  "perplexity",
  "railway",
  "runway",
  "sentry",
  "slack-webhook",
  "supabase",
  "supadata",
  "todoist",
  "youtube",
];

/**
 * Recognizable, commonly-used connectors we always surface during onboarding
 * even when external adoption is still low.
 */
const FEATURED_ONBOARDING_TYPES: readonly string[] = [
  "google-sheets",
  "google-meet",
  "dropbox",
  "discord",
  "zoom",
  "calendly",
  "asana",
  "clickup",
  "gitlab",
  "salesforce",
  "shopify",
  "canva",
  "perplexity",
  "x",
];

/**
 * Connector list shown in the onboarding picker: curated to external adoption
 * plus famous tools, most-adopted first. Unknown ids are ignored because this
 * intersects with the live catalog from {@link allConnectorTypes$}.
 */
export const onboardingConnectorTypes$ = computed(async (get) => {
  const all = await get(allConnectorTypes$);
  const onboardingTypes = new Set<string>([
    ...EXTERNAL_ADOPTED_ONBOARDING_TYPES,
    ...FEATURED_ONBOARDING_TYPES,
  ]);
  const adoptionRank = new Map<string, number>(
    EXTERNAL_ADOPTED_ONBOARDING_TYPES.map((type, index) => {
      return [type, index];
    }),
  );
  return all
    .filter((connector) => {
      return onboardingTypes.has(connector.type);
    })
    .sort((a, b) => {
      const ra = adoptionRank.get(a.type) ?? Number.MAX_SAFE_INTEGER;
      const rb = adoptionRank.get(b.type) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
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

export const manualGrantFormValuesFor$ = (type: string) => {
  return computed((get) => {
    return get(manualGrantFormValues$)[type] ?? {};
  });
};

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
  ) => {
    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const connectorClient = createClient(zeroConnectorManualGrantContract);
        await accept(
          connectorClient.connect({
            params: { type },
            body: {
              authMethod,
              values: sanitizeTokenInputRecord(inputValues),
            },
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
  readonly authMethod: ConnectorAuthMethodId;
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
    const client = createClient(zeroConnectorOauthDeviceAuthSessionContract);
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
        const current = get(internalConnectorOAuthDeviceAuthState$);
        if (!isCurrentRequest(current)) {
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
        if (!isCurrentRequest(latest)) {
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
            authMethod,
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

export const connectConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!hasConnectorDeviceAuthGrant(type)) {
      throw new Error(`${type} does not use device authorization OAuth`);
    }
    assertConnectorUsesDeviceAuthMethod(type, authMethod);

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
        );
        const startSettled = await settle(
          accept(
            client.create({
              params: { type },
              body: { authMethod },
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
            authMethod,
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
          authMethod,
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
            !signal.aborted ||
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
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthDeviceAuth$,
      args.type,
      args.authMethod,
      args.options,
      signal,
    );
    if (connected) {
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

function assertConnectorUsesAuthCodeMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): void {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    throw new Error(`${type} does not have ${authMethod} auth method`);
  }
  if (method.grant.kind !== "auth-code") {
    throw new Error(`${type} ${authMethod} does not use an auth-code grant`);
  }
}

function assertConnectorUsesDeviceAuthMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): void {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    throw new Error(`${type} does not have ${authMethod} auth method`);
  }
  if (method.grant.kind !== "device-auth") {
    throw new Error(`${type} ${authMethod} does not use a device-auth grant`);
  }
}

function connectorMatchesAuthMethod(
  connector: ConnectorResponse,
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return connector.type === type && connector.authMethod === authMethod;
}

const openConnectorOAuthAuthCodeWindow$ = command(
  async (
    { get },
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
    signal: AbortSignal,
  ) => {
    assertConnectorUsesAuthCodeMethod(type, authMethod);

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
        body: { authMethod },
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
    authMethod: ConnectorAuthMethodId,
    options: PostConnectOptions,
    signal: AbortSignal,
  ) => {
    assertConnectorUsesAuthCodeMethod(type, authMethod);

    const flow = createConnectorConnectFlowState(type);
    set(internalConnectFlowState$, flow);
    set(internalPollingOAuthAuthCodeConnectorType$, type);

    return await withCleanup(
      (async () => {
        const authWindow = await set(
          openConnectorOAuthAuthCodeWindow$,
          type,
          authMethod,
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
              return connectorMatchesAuthMethod(c, type, authMethod);
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
          return connectorMatchesAuthMethod(c, type, authMethod);
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
    args: {
      readonly type: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
      readonly onSuccess: () => void | Promise<void>;
      readonly options: PostConnectOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      args.type,
      args.authMethod,
      args.options,
      signal,
    );
    if (connected) {
      await args.onSuccess();
    }
  },
);
