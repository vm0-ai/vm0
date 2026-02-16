import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import Nango from "@nangohq/frontend";
import {
  CONNECTOR_TYPES,
  FeatureSwitchKey,
  type ConnectorType,
  type ConnectorResponse,
} from "@vm0/core";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  connectors$,
  reloadConnectors$,
  deleteConnector$,
} from "../external/connectors.ts";
import { apiBase$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";

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
}

/**
 * Check if a connector type uses Nango Cloud platform
 */
function isNangoConnector(type: ConnectorType): boolean {
  return type === "gmail";
}

export const allConnectorTypes$ = computed(async (get) => {
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));
  const features = await get(featureSwitch$);

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => {
      // Filter computer connector based on feature flag
      if (
        type === "computer" &&
        !features?.[FeatureSwitchKey.ComputerConnector]
      ) {
        return false;
      }
      // Filter Nango connectors based on feature flag
      if (
        isNangoConnector(type) &&
        !features?.[FeatureSwitchKey.ConnectorNango]
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
      };
    });
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
    const apiBase = get(apiBase$);
    const baseUrl = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;

    set(internalPollingType$, type);

    try {
      // Create Connect Session
      const response = await fetch(
        `${baseUrl}/api/connectors/${type}/create-session`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      signal.throwIfAborted();

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.statusText}`);
      }

      const { sessionToken } = await response.json();
      signal.throwIfAborted();

      // Use Nango Frontend SDK
      const nango = new Nango();
      const connectUI = nango.openConnectUI({
        sessionToken,
        onEvent: async (event) => {
          if (event.type === "connect") {
            // Connection successful!
            set(internalPollingType$, null);

            // Reload connectors to show new connection
            await set(reloadConnectors$);

            const connectorLabel = CONNECTOR_TYPES[type]?.label ?? type;
            toast.success(`${connectorLabel} connected successfully`);
          } else if (event.type === "close") {
            // User closed the modal
            set(internalPollingType$, null);
          }
        },
      });

      // Cleanup on abort
      signal.addEventListener("abort", () => {
        set(internalPollingType$, null);
        // Close Connect UI if still open
        if (connectUI && typeof connectUI.close === "function") {
          connectUI.close();
        }
      });
    } catch (error) {
      throwIfAbort(error);
      set(internalPollingType$, null);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to connect: ${errorMessage}`);
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
