import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type ConnectorDisplayCategory,
} from "@vm0/connectors/connectors";
import { hasRequiredScopes } from "@vm0/connectors/connector-utils";
import {
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
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
import { apiBaseForNavigation$ } from "../../fetch.ts";
import { zeroClient$ } from "../../api-client.ts";
import { jsonParseOr, resetSignal, withCleanup } from "../../utils.ts";
import { setAblyLoop$ } from "../../realtime.ts";
import { localStorageSignals } from "../../external/local-storage.ts";
import { resetPermissionDialog$ } from "./permission-dialog.ts";
import { sanitizeTokenInputRecord } from "./token-input.ts";

const HIDDEN_CONNECTIONS_STORAGE_KEY = "vm0.connections.hiddenTypes";
const { get$: hiddenConnectorTypesRaw$, set$: setHiddenConnectorTypes$ } =
  localStorageSignals(HIDDEN_CONNECTIONS_STORAGE_KEY);

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
  availableAuthMethods: string[];
  /** True if at least one agent references this connector (env mapping). */
  usedByAgent?: boolean;
  /** True if stored OAuth scopes don't cover all currently required scopes. */
  scopeMismatch: boolean;
  /** True if OAuth token refresh failed and user needs to reconnect. */
  needsReconnect: boolean;
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
      const flagEnabled = !flag || !!features?.[flag];
      const methods = CONNECTOR_TYPES[type].authMethods;
      // Connector visible if any auth method should be shown. api-token is
      // always available regardless of flag unless strictFeatureFlag is set;
      // oauth requires the per-connector flag.
      const showOauth = flagEnabled && "oauth" in methods;
      const showApiToken =
        "api-token" in methods &&
        (flagEnabled || !CONNECTOR_TYPES[type].strictFeatureFlag);
      return showOauth || showApiToken;
    })
    .map((type) => {
      const config = CONNECTOR_TYPES[type];
      const connector = connectorMap.get(type) ?? null;
      const flag = CONNECTOR_TYPES[type].featureFlag;
      const flagEnabled = !flag || !!features?.[flag];
      const showOauth = flagEnabled && "oauth" in config.authMethods;
      const showApiToken =
        "api-token" in config.authMethods &&
        (flagEnabled || !config.strictFeatureFlag);
      const availableAuthMethods: string[] = [];
      if (showOauth) {
        availableAuthMethods.push("oauth");
      }
      if (showApiToken) {
        availableAuthMethods.push("api-token");
      }
      const isExperimental = !!flag && !showApiToken;
      return {
        type,
        label: isExperimental ? `[Experimental] ${config.label}` : config.label,
        helpText: config.helpText,
        category: config.category,
        tags: config.tags ?? [],
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
    const createClient = get(zeroClient$);
    const secretsClient = createClient(zeroSecretsContract);
    const variablesClient = createClient(zeroVariablesContract);
    const apiTokenConfig = CONNECTOR_TYPES[type].authMethods["api-token"];
    const secrets = sanitizeTokenInputRecord(inputSecrets);
    for (const [name, value] of Object.entries(secrets)) {
      if (!value) {
        continue;
      }
      const isVariable = apiTokenConfig?.secrets[name]?.type === "variable";
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
    const baseUrl = await get(apiBaseForNavigation$);
    signal.throwIfAborted();

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
