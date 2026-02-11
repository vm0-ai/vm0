import { command, computed, state } from "ccstate";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type ConnectorResponse,
} from "@vm0/core";
import {
  connectors$,
  reloadConnectors$,
  deleteConnector$,
} from "../external/connectors.ts";
import { apiBase$ } from "../fetch.ts";

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

export const allConnectorTypes$ = computed(async (get) => {
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).map((type) => {
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
  ({ get, set }, type: ConnectorType, signal: AbortSignal) => {
    const apiBase = get(apiBase$);
    const baseUrl = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
    const authorizeUrl = `${baseUrl}/api/connectors/${type}/authorize`;

    window.open(authorizeUrl, "_blank");

    set(internalPollingType$, type);

    const interval = window.setInterval(() => {
      set(reloadConnectors$);
    }, 3000);

    // Stop polling after 5 minutes
    const timeout = window.setTimeout(
      () => {
        window.clearInterval(interval);
        set(internalPollingType$, null);
      },
      5 * 60 * 1000,
    );

    // Watch for connector appearing in list to stop polling early
    const checkConnected = async () => {
      const { connectors } = await get(connectors$);
      if (connectors.some((c) => c.type === type)) {
        window.clearInterval(interval);
        window.clearTimeout(timeout);
        set(internalPollingType$, null);
      }
    };

    const pollCheck = window.setInterval(async () => {
      await checkConnected();
    }, 3500);

    // Cleanup on abort
    signal.addEventListener("abort", () => {
      window.clearInterval(interval);
      window.clearInterval(pollCheck);
      window.clearTimeout(timeout);
      set(internalPollingType$, null);
    });
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

    const promise = (async () => {
      await set(deleteConnector$, dialogState.connectorType as string);
      signal.throwIfAborted();
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
