import { toast } from "@okouai/ui/components/ui/sonner";
import { command, state } from "ccstate";
import sharedDatabaseWorkerAssetUrl from "virtual:shared-database-worker";

import { i18n } from "../i18n/index.ts";
import {
  getCapturedPreviewBypassForTarget,
  VERCEL_PROTECTION_BYPASS_NAME,
} from "../lib/preview-bypass-cookie.ts";
import { sentryLogContext } from "../lib/sentry-config.ts";
import { derivePlatformServiceOrigin } from "../lib/platform-host.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../shared-database/bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../shared-database/data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import { SingleConnectionSharedDatabaseBridge } from "../shared-database/single-connection-client.ts";
import { clerk$ } from "./auth.ts";
import { waitForClerkSession } from "./clerk-token.ts";
import { applyChatThreadReadCursorUpdated$ } from "./chat-thread-list-reload.ts";
import {
  syncActiveChatEvents$,
  syncAllActiveChatEvents$,
} from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
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
const L = logger("SharedDatabaseBrowser");

export interface SharedDatabaseBridgeHost {
  createBridge(
    identity: SharedDatabaseIdentity,
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
  ): SharedDatabaseBridge;
}

function handleSharedDatabaseReloadRequired(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(SHARED_DATABASE_RELOAD_MARKER)) {
    url.searchParams.set(SHARED_DATABASE_RELOAD_MARKER, "1");
    location.replace(url.toString());
    return;
  }

  url.searchParams.delete(SHARED_DATABASE_RELOAD_MARKER);
  history.replaceState(history.state, "", url);
  toast.error(
    i18n.t(($) => {
      return $.global.errors.sharedDatabaseUnavailable;
    }),
  );
}

function createBrowserSharedDatabaseBridge(
  identity: SharedDatabaseIdentity,
  events: SharedDatabaseBridgeEvents,
  signal: AbortSignal,
): SharedDatabaseBridge {
  const workerUrl = new URL(sharedDatabaseWorkerAssetUrl, location.href);
  workerUrl.search = "";
  workerUrl.searchParams.set("userId", identity.userId);
  workerUrl.searchParams.set("orgId", identity.orgId);
  const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
  const vercelProtectionBypass = getCapturedPreviewBypassForTarget(apiBaseUrl);
  if (vercelProtectionBypass) {
    workerUrl.searchParams.set(
      VERCEL_PROTECTION_BYPASS_NAME,
      vercelProtectionBypass,
    );
  }
  const worker = new SharedWorker(workerUrl, {
    name: `okou_${identity.userId}_${identity.orgId}`,
    type: "module",
  });
  const portBridge = new MessagePortSharedDatabaseBridge(worker.port, events);
  let failureHandled = false;
  worker.addEventListener(
    "error",
    (event) => {
      if (failureHandled) {
        return;
      }
      failureHandled = true;
      const workerError: unknown = event.error;
      L.error(
        "Shared database worker failed to load",
        workerError instanceof Error ? workerError : event.message,
        sentryLogContext({
          tags: {
            runtime: "shared-worker",
            worker: "shared-database",
          },
        }),
      );
      portBridge.fail(
        workerError instanceof Error
          ? workerError
          : new Error("Shared database worker failed to load"),
      );
      events.reloadRequired();
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
    const bridgeHost = get(sharedDatabaseBridgeHostState$);
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: (events, connectionSignal) => {
        return bridgeHost.createBridge(identity, events, connectionSignal);
      },
      events: {
        databaseInvalidated: async (dataKey) => {
          await set(syncSharedDatabaseInvalidation$, dataKey, signal);
        },
        databaseReconnected: async () => {
          await set(syncSharedDatabaseReconnect$, signal);
        },
        reloadRequired: () => {
          handleSharedDatabaseReloadRequired();
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
