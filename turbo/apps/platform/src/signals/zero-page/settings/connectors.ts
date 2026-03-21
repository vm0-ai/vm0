import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  CONNECTOR_TYPES,
  hasRequiredScopes,
  zeroSecretsContract,
  zeroVariablesContract,
  type ConnectorType,
  type ConnectorResponse,
} from "@vm0/core";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { connectors$, reloadConnectors$ } from "../../external/connectors.ts";
import { apiBaseForNavigation$ } from "../../fetch.ts";
import { zeroClient$ } from "../../api-client.ts";
import { throwIfAbort } from "../../utils.ts";
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
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));
  const features = await get(featureSwitch$);

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
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
// Add connection dialog state
// ---------------------------------------------------------------------------

const internalAddConnectionDialogOpen$ = state(false);
export const addConnectionDialogOpen$ = computed((get) =>
  get(internalAddConnectionDialogOpen$),
);
export const setAddConnectionDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalAddConnectionDialogOpen$, open);
});

const internalAddConnectionDialogTab$ = state<"connectors" | "custom-api">(
  "connectors",
);
export const addConnectionDialogTab$ = computed((get) =>
  get(internalAddConnectionDialogTab$),
);
export const setAddConnectionDialogTab$ = command(
  ({ set }, tab: "connectors" | "custom-api") => {
    set(internalAddConnectionDialogTab$, tab);
  },
);

// ---------------------------------------------------------------------------
// Selected connector for connect modal
// ---------------------------------------------------------------------------

const internalSelectedConnectorType$ = state<ConnectorType | null>(null);
export const selectedConnectorType$ = computed((get) =>
  get(internalSelectedConnectorType$),
);
export const setSelectedConnectorType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalSelectedConnectorType$, type);
  },
);

// ---------------------------------------------------------------------------
// Scope review modal state
// ---------------------------------------------------------------------------

const internalScopeReviewType$ = state<ConnectorType | null>(null);
export const scopeReviewType$ = computed((get) =>
  get(internalScopeReviewType$),
);
export const setScopeReviewType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalScopeReviewType$, type);
  },
);

// ---------------------------------------------------------------------------
// Token form state (used by add-connection dialog)
// ---------------------------------------------------------------------------

const tokenFormValues$ = state<Record<string, Record<string, string>>>({});
export const tokenFormSubmitting$ = computed((get) =>
  get(internalTokenFormSubmitting$),
);
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

export const tokenFormValuesFor$ = (type: string) =>
  computed((get) => get(tokenFormValues$)[type] ?? {});

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
    set(internalJustConnectedTypes$, (prev) => new Set([...prev, type]));
    set(reloadConnectors$);
    // Show in connections list
    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.delete(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
    toast.success(`${CONNECTOR_TYPES[type].label} connected successfully`);
  },
);

// ---------------------------------------------------------------------------
// Polling state (for connect flow)
// ---------------------------------------------------------------------------

const internalPollingType$ = state<ConnectorType | null>(null);

export const pollingConnectorType$ = computed((get) =>
  get(internalPollingType$),
);

// ---------------------------------------------------------------------------
// Optimistic connected state — bridges the gap between connect success and
// allConnectorTypes$ recomputation so the UI doesn't flash.
// ---------------------------------------------------------------------------

const internalJustConnectedTypes$ = state<Set<string>>(new Set());

/** Types that were just connected but may not yet be reflected in allConnectorTypes$. */
export const justConnectedTypes$ = computed((get) =>
  get(internalJustConnectedTypes$),
);

export const clearJustConnectedTypes$ = command(({ set }) => {
  set(internalJustConnectedTypes$, new Set());
});

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

export const connectConnector$ = command(
  async ({ get, set }, type: ConnectorType, signal: AbortSignal) => {
    const baseUrl = get(apiBaseForNavigation$);

    set(internalPollingType$, type);

    const authWindow = window.open(
      `${baseUrl}/api/connectors/${type}/authorize`,
      "_blank",
      "width=600,height=700",
    );

    if (!authWindow) {
      throw new Error("Failed to open authorization window");
    }

    while (true) {
      await delay(500, { signal });

      if (!authWindow.closed) {
        continue;
      }

      set(reloadConnectors$);
      const { connectors: freshConnectors } = await get(connectors$);
      signal.throwIfAborted();

      // Mark as optimistically connected before clearing polling so the UI
      // transitions directly from "Connecting…" to "Connected" without flash.
      const isConnected = freshConnectors.some((c) => c.type === type);
      if (isConnected) {
        set(internalJustConnectedTypes$, (prev) => new Set([...prev, type]));
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
    }
  },
);
