import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  CONNECTOR_TYPES,
  FeatureSwitchKey,
  hasRequiredScopes,
  type ConnectorType,
  type ConnectorResponse,
} from "@vm0/core";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  connectors$,
  reloadConnectors$,
  deleteConnector$,
} from "../external/connectors.ts";
import { apiBaseForNavigation$, fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { delay } from "signal-timers";
import { localStorageSignals } from "../external/local-storage.ts";

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
  /** True if at least one agent references this connector (env mapping). */
  usedByAgent?: boolean;
  /** True if stored OAuth scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
}

/**
 * Maps connector types that are gated behind a feature flag to their
 * corresponding feature switch key.  Connectors not listed here are
 * always visible.
 */
const CONNECTOR_FEATURE_FLAGS = Object.freeze<
  Partial<Record<ConnectorType, FeatureSwitchKey>>
>({
  airtable: FeatureSwitchKey.AirtableConnector,
  computer: FeatureSwitchKey.ComputerConnector,
  deel: FeatureSwitchKey.DeelConnector,
  docusign: FeatureSwitchKey.DocuSignConnector,
  dropbox: FeatureSwitchKey.DropboxConnector,
  figma: FeatureSwitchKey.FigmaConnector,
  gmail: FeatureSwitchKey.GmailConnector,
  "google-sheets": FeatureSwitchKey.GoogleSheetsConnector,
  "google-docs": FeatureSwitchKey.GoogleDocsConnector,
  "google-drive": FeatureSwitchKey.GoogleDriveConnector,
  strava: FeatureSwitchKey.StravaConnector,
  "garmin-connect": FeatureSwitchKey.GarminConnectConnector,
  wix: FeatureSwitchKey.WixConnector,
  supabase: FeatureSwitchKey.SupabaseConnector,
});

export const allConnectorTypes$ = computed(async (get) => {
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));
  const features = await get(featureSwitch$);

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => {
      const flag = CONNECTOR_FEATURE_FLAGS[type];
      if (flag && !features?.[flag]) {
        return false;
      }
      // Filter mercury connector based on feature flag
      if (
        type === "mercury" &&
        !features?.[FeatureSwitchKey.MercuryConnector]
      ) {
        return false;
      }
      return true;
    })
    .map((type) => {
      const config = CONNECTOR_TYPES[type];
      const connector = connectorMap.get(type) ?? null;
      return {
        type,
        label: config.label,
        helpText: config.helpText,
        connected: connector !== null,
        connector,
        scopeMismatch:
          connector !== null && !hasRequiredScopes(type, connector.oauthScopes),
      };
    });
});

// ---------------------------------------------------------------------------
// Connector types used by any agent (from required-env)
// ---------------------------------------------------------------------------

const connectorTypesUsedByAgents$ = computed(
  async (get): Promise<Set<ConnectorType>> => {
    const fetchFn = get(fetch$);
    const resp = await fetchFn("/api/agent/required-env");
    if (!resp.ok) {
      return new Set();
    }
    const data = (await resp.json()) as {
      agents: { requiredSecrets: string[]; requiredVariables: string[] }[];
    };
    const requiredNames = new Set<string>();
    for (const agent of data.agents ?? []) {
      for (const name of agent.requiredSecrets ?? []) {
        requiredNames.add(name);
      }
    }
    const used = new Set<ConnectorType>();
    for (const type of Object.keys(CONNECTOR_TYPES) as ConnectorType[]) {
      if (type === "computer") {
        continue;
      }
      const config = CONNECTOR_TYPES[type];
      const mapping = config.environmentMapping as
        | Record<string, string>
        | undefined;
      if (!mapping) {
        continue;
      }
      for (const [envVar, ref] of Object.entries(mapping)) {
        if (requiredNames.has(envVar)) {
          used.add(type);
          break;
        }
        const secretName = ref.startsWith("$secrets.")
          ? ref.slice("$secrets.".length)
          : null;
        if (secretName && requiredNames.has(secretName)) {
          used.add(type);
          break;
        }
      }
    }
    return used;
  },
);

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

/** Remove a connector type from the connections list (does not disconnect). */
export const removeFromConnectionsList$ = command(
  ({ get, set }, type: ConnectorType) => {
    const hidden = new Set(get(hiddenConnectorTypes$));
    hidden.add(type);
    set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
  },
);

// ---------------------------------------------------------------------------
// Connections list items (connected + used by agents, minus hidden)
// ---------------------------------------------------------------------------

export const connectionsListItems$ = computed(async (get) => {
  const [allTypes, usedByAgents, hidden] = await Promise.all([
    get(allConnectorTypes$),
    get(connectorTypesUsedByAgents$),
    get(hiddenConnectorTypes$),
  ]);
  return allTypes
    .filter(
      (item) =>
        (item.connected || usedByAgents.has(item.type)) &&
        !hidden.has(item.type),
    )
    .map((item) => ({
      ...item,
      usedByAgent: usedByAgents.has(item.type),
    }));
});

// ---------------------------------------------------------------------------
// Polling state (for connect flow)
// ---------------------------------------------------------------------------

const internalPollingType$ = state<ConnectorType | null>(null);

export const pollingConnectorType$ = computed((get) =>
  get(internalPollingType$),
);

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
      await get(connectors$);
      signal.throwIfAborted();

      set(internalPollingType$, null);
      // Show in connections list again when user connects
      const hidden = new Set(get(hiddenConnectorTypes$));
      hidden.delete(type);
      set(setHiddenConnectorTypes$, JSON.stringify([...hidden]));
      break;
    }
  },
);

// ---------------------------------------------------------------------------
// Disconnect dialog state
// ---------------------------------------------------------------------------

interface DisconnectDialogState {
  open: boolean;
  connectorType: ConnectorType | null;
}

const internalDisconnectDialogState$ = state<DisconnectDialogState>({
  open: false,
  connectorType: null,
});

export const disconnectDialogState$ = computed((get) =>
  get(internalDisconnectDialogState$),
);

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalActionPromise$ = state<Promise<unknown> | null>(null);

export const connectorActionPromise$ = computed((get) =>
  get(internalActionPromise$),
);

// ---------------------------------------------------------------------------
// Commands: disconnect dialog
// ---------------------------------------------------------------------------

export const openDisconnectDialog$ = command(
  ({ set }, connectorType: ConnectorType) => {
    set(internalDisconnectDialogState$, { open: true, connectorType });
  },
);

export const closeDisconnectDialog$ = command(({ set }) => {
  set(internalDisconnectDialogState$, { open: false, connectorType: null });
});

export const confirmDisconnect$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalDisconnectDialogState$);
    if (!dialogState.connectorType) {
      return;
    }

    const connectorLabel =
      CONNECTOR_TYPES[dialogState.connectorType]?.label ??
      dialogState.connectorType;

    const promise = (async () => {
      await set(deleteConnector$, dialogState.connectorType as string);
      signal.throwIfAborted();
      toast.success(`${connectorLabel} disconnected successfully`);
      set(internalDisconnectDialogState$, {
        open: false,
        connectorType: null,
      });
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
