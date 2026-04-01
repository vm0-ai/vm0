import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  CONNECTOR_TYPES,
  hasRequiredScopes,
  zeroConnectorScopeDiffContract,
  zeroSecretsContract,
  zeroVariablesContract,
  type ConnectorType,
  type ConnectorResponse,
  type ScopeDiff,
} from "@vm0/core";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { connectors$, reloadConnectors$ } from "../../external/connectors.ts";
import { apiBaseForNavigation$ } from "../../fetch.ts";
import { zeroClient$ } from "../../api-client.ts";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { delay } from "signal-timers";
import { localStorageSignals } from "../../external/local-storage.ts";

const HIDDEN_CONNECTIONS_STORAGE_KEY = "vm0.connections.hiddenTypes";
const { get$: hiddenConnectorTypesRaw$, set$: setHiddenConnectorTypes$ } =
  localStorageSignals(HIDDEN_CONNECTIONS_STORAGE_KEY);

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
  connected: boolean;
  connector: ConnectorResponse | null;
  /** Auth methods available for this connector (considering feature flags). */
  availableAuthMethods: string[];
  /** True if at least one agent references this connector (env mapping). */
  usedByAgent?: boolean;
  /** True if stored OAuth scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
  /** True if OAuth token refresh failed and user needs to reconnect. */
  needsReconnect: boolean;
}

export const allConnectorTypes$ = computed(async (get) => {
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(
    connectors.map((c) => {
      return [c.type, c];
    }),
  );
  const features = await get(featureSwitch$);

  const items = (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => {
      const flag = CONNECTOR_TYPES[type].featureFlag;
      const oauthEnabled = !flag || !!features?.[flag];
      const hasApiToken = "api-token" in CONNECTOR_TYPES[type].authMethods;
      // Connector visible if OAuth is enabled OR it has an api-token method
      return oauthEnabled || hasApiToken;
    })
    .map((type) => {
      const config = CONNECTOR_TYPES[type];
      const connector = connectorMap.get(type) ?? null;
      const flag = CONNECTOR_TYPES[type].featureFlag;
      const oauthEnabled = !flag || !!features?.[flag];
      const hasApiToken = "api-token" in config.authMethods;
      const availableAuthMethods: string[] = [];
      if (oauthEnabled && "oauth" in config.authMethods) {
        availableAuthMethods.push("oauth");
      }
      if (hasApiToken) {
        availableAuthMethods.push("api-token");
      }
      const isExperimental = !!flag && !hasApiToken;
      return {
        type,
        label: isExperimental ? `[Experimental] ${config.label}` : config.label,
        helpText: config.helpText,
        connected: connector !== null,
        connector,
        availableAuthMethods,
        scopeMismatch:
          connector !== null &&
          connector.authMethod === "oauth" &&
          !hasRequiredScopes(type, connector.oauthScopes),
        needsReconnect: connector?.needsReconnect ?? false,
      };
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
  try {
    const arr = JSON.parse(raw) as string[];
    return new Set(arr as ConnectorType[]);
  } catch (error) {
    throwIfAbort(error);
    return new Set();
  }
});

// ---------------------------------------------------------------------------
// Selected connector for connect modal
// ---------------------------------------------------------------------------

const internalSelectedConnectorType$ = state<ConnectorType | null>(null);
export const selectedConnectorType$ = computed((get) => {
  return get(internalSelectedConnectorType$);
});
export const setSelectedConnectorType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalSelectedConnectorType$, type);
  },
);

// ---------------------------------------------------------------------------
// Scope review modal state
// ---------------------------------------------------------------------------

const L = logger("ScopeReviewModal");

const internalScopeReviewType$ = state<ConnectorType | null>(null);
export const scopeReviewType$ = computed((get) => {
  return get(internalScopeReviewType$);
});

const internalScopeDiff$ = state<ScopeDiff | null>(null);
export const scopeDiff$ = computed((get) => {
  return get(internalScopeDiff$);
});

const internalScopeReviewLoading$ = state(false);
export const scopeReviewLoading$ = computed((get) => {
  return get(internalScopeReviewLoading$);
});

const loadScopeDiff$ = command(
  async ({ get, set }, type: ConnectorType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroConnectorScopeDiffContract);
    try {
      const result = await client.getScopeDiff({ params: { type } });
      if (result.status === 200) {
        set(internalScopeDiff$, result.body);
      } else {
        L.error(`Failed to fetch scope diff: ${result.status}`, result.body);
      }
    } catch (error: unknown) {
      throwIfAbort(error);
      L.error("Failed to fetch scope diff:", error);
    } finally {
      set(internalScopeReviewLoading$, false);
    }
  },
);

export const setScopeReviewType$ = command(
  async ({ set }, type: ConnectorType | null, signal: AbortSignal) => {
    set(internalScopeReviewType$, type);
    if (type) {
      set(internalScopeDiff$, null);
      set(internalScopeReviewLoading$, true);
      await set(loadScopeDiff$, type, signal);
    }
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
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const secretsClient = createClient(zeroSecretsContract);
    const variablesClient = createClient(zeroVariablesContract);
    const apiTokenConfig = CONNECTOR_TYPES[type].authMethods["api-token"];
    for (const [name, value] of Object.entries(inputSecrets)) {
      if (!value) {
        continue;
      }
      const isVariable = apiTokenConfig?.secrets[name]?.type === "variable";
      const result = isVariable
        ? await variablesClient.set({ body: { name, value } })
        : await secretsClient.set({ body: { name, value } });
      signal.throwIfAborted();
      if (
        result.status === 400 ||
        result.status === 401 ||
        result.status === 500
      ) {
        throw new Error(
          result.body.error.message ??
            `Failed to save ${name} (${result.status})`,
        );
      }
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
  },
);

// ---------------------------------------------------------------------------
// Polling state (for connect flow)
// ---------------------------------------------------------------------------

const internalPollingType$ = state<ConnectorType | null>(null);

export const pollingConnectorType$ = computed((get) => {
  return get(internalPollingType$);
});

// ---------------------------------------------------------------------------
// Optimistic connected state — bridges the gap between connect success and
// allConnectorTypes$ recomputation so the UI doesn't flash.
// ---------------------------------------------------------------------------

const internalJustConnectedTypes$ = state<Set<string>>(new Set());

/** Types that were just connected but may not yet be reflected in allConnectorTypes$. */
export const justConnectedTypes$ = computed((get) => {
  return get(internalJustConnectedTypes$);
});

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

export const connectConnector$ = command(
  async ({ get, set }, type: ConnectorType, signal: AbortSignal) => {
    const baseUrl = get(apiBaseForNavigation$);

    set(internalPollingType$, type);

    const authWindow = window.open(
      `${baseUrl}/api/zero/connectors/${type}/authorize`,
      "_blank",
      "width=600,height=700",
    );

    if (!authWindow) {
      throw new Error("Failed to open authorization window");
    }

    // Poll the API until the connector appears or the popup is closed.
    // The platform and OAuth callback page live on different origins
    // (app.* vs www.*), so BroadcastChannel cannot be used.
    let freshConnectors: ConnectorResponse[] = [];
    while (true) {
      await delay(2000, { signal });

      set(reloadConnectors$);
      const { connectors: polled } = await get(connectors$);
      signal.throwIfAborted();

      if (
        polled.some((c) => {
          return c.type === type;
        })
      ) {
        freshConnectors = polled;
        break;
      }

      if (authWindow.closed) {
        freshConnectors = polled;
        break;
      }
    }

    // Mark as optimistically connected before clearing polling so the UI
    // transitions directly from "Connecting…" to "Connected" without flash.
    const isConnected = freshConnectors.some((c) => {
      return c.type === type;
    });
    if (isConnected) {
      set(internalJustConnectedTypes$, (prev) => {
        return new Set([...prev, type]);
      });
    }
    set(internalPollingType$, null);
    // Show in connections list again when user connects
    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.delete(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
    // Close connect modal on OAuth success
    if (isConnected) {
      set(internalSelectedConnectorType$, null);
    }
    return isConnected;
  },
);
