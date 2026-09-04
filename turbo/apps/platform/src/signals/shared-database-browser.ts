import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, state } from "ccstate";
import sharedDatabaseWorkerAssetUrl from "virtual:shared-database-worker";

import { i18n } from "../i18n/index.ts";
import { now } from "../lib/time.ts";
import {
  CLERK_DEV_BROWSER_NAME,
  readClerkDevBrowserJwt,
} from "../lib/clerk-dev-browser.ts";
import { resolveConfiguredProductionPrimaryAppDomain } from "../lib/clerk-instance-config.ts";
import { CLERK_PRIMARY_APP_DOMAIN_PARAM } from "../lib/clerk-primary-app-domain-param.ts";
import { CONNECTION_DIAGNOSTICS_PARAM } from "../lib/connection-diagnostics-param.ts";
import { derivePlatformServiceOrigin } from "../lib/platform-host.ts";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import { VERCEL_PROTECTION_BYPASS_NAME } from "../lib/preview-bypass-name.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../shared-database/bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../shared-database/data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import type { SharedDatabaseWorkerUnavailableReason } from "../shared-database/protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../shared-database/single-connection-client.ts";
import { clerk$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { waitForClerkSession } from "./clerk-token.ts";
import { applyChatThreadReadCursorUpdated$ } from "./chat-thread-list-reload.ts";
import {
  syncActiveChatEvents$,
  syncAllActiveChatEvents$,
} from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { reportForceUpgradeRequired } from "./force-upgrade.ts";
import { logger } from "./log.ts";
import {
  installSharedDatabaseBridge$,
  setBridgeConnected$,
  sharedDatabaseBridgeInstalled$,
} from "./shared-database-bridge-state.ts";
import {
  reloadComputedFromWorker$,
  setSharedDatabaseConnectionStatus$,
} from "./shared-database.ts";
import { createDeferredPromise, onRejection } from "./utils.ts";

const SHARED_DATABASE_RELOAD_MARKER = "okou-shared-database-reload";
const SHARED_DATABASE_RELOAD_WINDOW_MS = 60_000;
const L = logger("SharedWorkerBridge");

export interface SharedDatabaseBridgeHost {
  createBridge(
    identity: SharedDatabaseIdentity,
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
    diagnosticsEnabled: boolean,
  ): SharedDatabaseBridge;
}

function handleSharedDatabaseReloadRequired(
  reason: SharedDatabaseWorkerUnavailableReason,
): void {
  const url = new URL(location.href);
  const reloadAtMs = now();
  const reloadMarker = url.searchParams.get(SHARED_DATABASE_RELOAD_MARKER);
  const previousReloadAtMs =
    reloadMarker === null ? Number.NaN : Number(reloadMarker);
  if (
    Number.isFinite(previousReloadAtMs) &&
    reloadAtMs - previousReloadAtMs < SHARED_DATABASE_RELOAD_WINDOW_MS
  ) {
    url.searchParams.delete(SHARED_DATABASE_RELOAD_MARKER);
    history.replaceState(history.state, "", url);
    toast.error(
      i18n.t(($) => {
        return $.global.errors.sharedDatabaseUnavailable;
      }),
    );
    return;
  }

  url.searchParams.set(SHARED_DATABASE_RELOAD_MARKER, String(reloadAtMs));
  L.debug("Reloading app", { reason });
  location.replace(url.toString());
}

function handleSharedDatabaseWorkerUnavailable(
  reason: SharedDatabaseWorkerUnavailableReason,
): void {
  if (reason === "force-upgrade-required") {
    reportForceUpgradeRequired();
    return;
  }

  handleSharedDatabaseReloadRequired(reason);
  if (reason === "indexeddb-version-changed") {
    throw new Error(
      "Shared database worker is unavailable after an IndexedDB version change",
    );
  }
  throw new Error(
    "Shared database worker failed to load or its transport became unrecoverable",
  );
}

function createBrowserSharedDatabaseBridge(
  identity: SharedDatabaseIdentity,
  events: SharedDatabaseBridgeEvents,
  signal: AbortSignal,
  diagnosticsEnabled: boolean,
): SharedDatabaseBridge {
  const workerUrl = new URL(sharedDatabaseWorkerAssetUrl, location.href);
  workerUrl.search = "";
  workerUrl.searchParams.set("userId", identity.userId);
  workerUrl.searchParams.set("orgId", identity.orgId);
  // The Worker bundle has no copy of the deployment's primary app domain (it
  // is substituted into index.html after the build), so the tab forwards it.
  workerUrl.searchParams.set(
    CLERK_PRIMARY_APP_DOMAIN_PARAM,
    resolveConfiguredProductionPrimaryAppDomain(),
  );
  const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
  const vercelProtectionBypass = getCapturedPreviewBypassForTarget(apiBaseUrl);
  if (vercelProtectionBypass) {
    workerUrl.searchParams.set(
      VERCEL_PROTECTION_BYPASS_NAME,
      vercelProtectionBypass,
    );
  }
  const devBrowserJwt = readClerkDevBrowserJwt(document.cookie);
  if (devBrowserJwt) {
    workerUrl.searchParams.set(CLERK_DEV_BROWSER_NAME, devBrowserJwt);
  }
  if (diagnosticsEnabled) {
    workerUrl.searchParams.set(CONNECTION_DIAGNOSTICS_PARAM, "1");
  }
  const worker = new SharedWorker(workerUrl, {
    // The capture decision is part of the URL, so it has to be part of the
    // name too: a tab that disagrees gets its own Worker instead of a
    // URLMismatchError against the running one.
    name: `okou_${identity.userId}_${identity.orgId}${diagnosticsEnabled ? "_diagnostics" : ""}`,
    type: "module",
  });
  const portBridge = new MessagePortSharedDatabaseBridge(
    worker.port,
    events,
    signal,
  );
  let failureHandled = false;
  worker.addEventListener(
    "error",
    (event) => {
      if (failureHandled) {
        return;
      }
      failureHandled = true;
      const workerError: unknown = event.error;
      portBridge.fail(
        workerError instanceof Error
          ? workerError
          : new Error("Shared database worker failed to load"),
      );
      events.workerUnavailable("worker-load-or-transport-failure");
    },
    { signal },
  );
  return portBridge;
}

const sharedDatabaseBridgeHostState$ = state<SharedDatabaseBridgeHost>({
  createBridge: createBrowserSharedDatabaseBridge,
});

const preparedSharedDatabaseBridgeState$ =
  state<SingleConnectionSharedDatabaseBridge | null>(null);

const syncSharedDatabaseInvalidation$ = command(
  async (
    { set },
    dataKey: SharedDatabaseDataKey,
    signal: AbortSignal,
  ): Promise<void> => {
    if (dataKey.kind === "chat-event") {
      await set(syncActiveChatEvents$, dataKey.threadId, signal);
      return;
    }
    await set(syncEventDrivenChatThreads$, signal);
  },
);

const syncSharedDatabaseReconnect$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await Promise.all([
      set(syncAllActiveChatEvents$, signal),
      set(syncEventDrivenChatThreads$, signal),
    ]);
  },
);

export const setSharedDatabaseBridgeHostForTest$ = command(
  ({ set }, host: SharedDatabaseBridgeHost): void => {
    set(sharedDatabaseBridgeHostState$, host);
  },
);

export const prepareSharedDatabaseBridge$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<SingleConnectionSharedDatabaseBridge | null> => {
    signal.throwIfAborted();
    const existing = get(preparedSharedDatabaseBridgeState$);
    if (existing) {
      await existing.prepare(signal);
      return existing;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const session = await waitForClerkSession(clerk, signal);
    signal.throwIfAborted();
    if (!session || !clerk.user || !clerk.organization) {
      return null;
    }
    const identity = {
      userId: clerk.user.id,
      orgId: clerk.organization.id,
    };
    const diagnosticsEnabled =
      get(featureSwitch$)[FeatureSwitchKey.OkouDebug] ?? false;
    const bridgeHost = get(sharedDatabaseBridgeHostState$);
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: (events, connectionSignal) => {
        return bridgeHost.createBridge(
          identity,
          events,
          connectionSignal,
          diagnosticsEnabled,
        );
      },
      events: {
        databaseInvalidated: async (dataKey) => {
          await set(syncSharedDatabaseInvalidation$, dataKey, signal);
        },
        databaseReconnected: async () => {
          await set(syncSharedDatabaseReconnect$, signal);
        },
        workerUnavailable: (reason) => {
          handleSharedDatabaseWorkerUnavailable(reason);
        },
        computedReloaded: (computedKey) => {
          set(reloadComputedFromWorker$, computedKey);
        },
        chatThreadReadCursorUpdated: (payload) => {
          set(applyChatThreadReadCursorUpdated$, payload);
        },
        statusChanged: (status) => {
          set(setSharedDatabaseConnectionStatus$, status);
        },
      },
    });
    set(preparedSharedDatabaseBridgeState$, bridge);
    await bridge.prepare(signal);
    return bridge;
  },
);

type BridgeConnection = ReturnType<typeof createDeferredPromise<void>>;

const connectSharedDatabaseBridge$ = command(
  async (
    { get, set },
    connected: BridgeConnection,
    signal: AbortSignal,
  ): Promise<void> => {
    if (get(sharedDatabaseBridgeInstalled$)) {
      connected.resolve(undefined);
      return;
    }
    const bridge = await set(prepareSharedDatabaseBridge$, signal);
    signal.throwIfAborted();
    if (!bridge) {
      return;
    }
    await set(installSharedDatabaseBridge$, bridge, signal);
    signal.throwIfAborted();
    connected.resolve(undefined);
  },
);

export const setupSharedDatabaseBridge$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const connected = createDeferredPromise<void>(signal);
    set(setBridgeConnected$, connected.promise);
    await onRejection(
      set(connectSharedDatabaseBridge$, connected, signal),
      (error) => {
        if (!connected.settled()) {
          connected.reject(error);
        }
      },
    );
    signal.throwIfAborted();
  },
);
