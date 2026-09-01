import { command, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { delay } from "signal-timers";
import sharedDatabaseWorkerAssetUrl from "virtual:shared-database-worker";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import { sentryLogContext } from "../lib/sentry-config.ts";
import { i18n } from "../i18n/index.ts";
import { resolveApiBaseForTarget } from "./api-base.ts";
import { clerk$, reloadToken$ } from "./auth.ts";
import { readClerkToken } from "./clerk-token.ts";
import { applyChatThreadReadCursorUpdated$ } from "./chat-thread-list-reload.ts";
import {
  syncActiveChatEvents$,
  syncAllActiveChatEvents$,
} from "./chat-page/chat-event-signal-registry.ts";
import { syncEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { logger } from "./log.ts";
import {
  createDeferredPromise,
  jsonParseOr,
  onRejection,
  onDomEventFn,
  setLoop,
} from "./utils.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import { AuthRecoveringSharedDatabaseBridge } from "../shared-database/auth-recovering-client.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../shared-database/bridge.ts";
import { SingleConnectionSharedDatabaseBridge } from "../shared-database/single-connection-client.ts";
import {
  heartbeatSharedDatabase$,
  installSharedDatabaseBridge$,
  setBridgeConnected$,
  sharedDatabaseBridgeInstalled$,
} from "./shared-database-bridge-state.ts";
import {
  reloadComputedFromWorker$,
  setSharedDatabaseConnectionStatus$,
} from "./shared-database.ts";
import type { SharedDatabaseDataKey } from "../shared-database/data-key.ts";

const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const AUTHENTICATION_REQUIRED_EVENT = "authentication-required";
const SHARED_DATABASE_RELOAD_MARKER = "okou-shared-database-reload";
const L = logger("SharedDatabaseBrowser");

export interface SharedDatabaseBridgeHost {
  createBridge(
    apiBaseUrl: string,
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
  ): SharedDatabaseBridge;
}

interface JwtLifetime {
  readonly exp: number;
  readonly iat: number;
}

function jwtLifetime(token: string): JwtLifetime | null {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    return null;
  }
  if (
    !/^[A-Za-z0-9_-]+$/u.test(encodedPayload) ||
    encodedPayload.length % 4 === 1
  ) {
    return null;
  }
  const normalized = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const value = jsonParseOr<unknown>(atob(padded), null);
  if (
    typeof value !== "object" ||
    value === null ||
    !("exp" in value) ||
    !("iat" in value) ||
    typeof value.exp !== "number" ||
    typeof value.iat !== "number" ||
    value.exp <= value.iat
  ) {
    return null;
  }
  return { exp: value.exp, iat: value.iat };
}

function heartbeatInterval(token: string): number {
  const lifetime = jwtLifetime(token);
  if (!lifetime) {
    return MAX_HEARTBEAT_INTERVAL_MS;
  }
  return Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    ((lifetime.exp - lifetime.iat) * 1000) / 2,
  );
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
  apiBaseUrl: string,
  events: SharedDatabaseBridgeEvents,
  signal: AbortSignal,
): SharedDatabaseBridge {
  const worker = new SharedWorker(
    new URL(sharedDatabaseWorkerAssetUrl, location.href),
    {
      name: "okou core service",
      type: "module",
    },
  );
  const portBridge = new MessagePortSharedDatabaseBridge(
    worker.port,
    apiBaseUrl,
    events,
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

interface PreparedSharedDatabaseBridge {
  readonly apiBaseUrl: string;
  readonly authenticationRequiredTarget: EventTarget;
  readonly bridge: SingleConnectionSharedDatabaseBridge;
}

const preparedSharedDatabaseBridgeState$ =
  state<PreparedSharedDatabaseBridge | null>(null);

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
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const existing = get(preparedSharedDatabaseBridgeState$);
    if (existing) {
      await existing.bridge.prepare(signal);
      return;
    }
    const apiBaseUrl = resolveApiBaseForTarget("api");
    const bridgeHost = get(sharedDatabaseBridgeHostState$);
    const authenticationRequiredTarget = new EventTarget();
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: (events, connectionSignal) => {
        return bridgeHost.createBridge(apiBaseUrl, events, connectionSignal);
      },
      events: {
        authenticationRequired: () => {
          authenticationRequiredTarget.dispatchEvent(
            new Event(AUTHENTICATION_REQUIRED_EVENT),
          );
        },
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
    set(preparedSharedDatabaseBridgeState$, {
      apiBaseUrl,
      authenticationRequiredTarget,
      bridge,
    });
    await bridge.prepare(signal);
  },
);

type BridgeConnection = ReturnType<typeof createDeferredPromise<void>>;

const connectSharedDatabaseBridge$ = command(
  async (
    { get, set },
    connected: BridgeConnection,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (get(sharedDatabaseBridgeInstalled$)) {
      connected.resolve(undefined);
      return null;
    }

    const prepare = set(prepareSharedDatabaseBridge$, signal);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      await prepare;
      signal.throwIfAborted();
      return null;
    }
    const [, token] = await Promise.all([
      prepare,
      readClerkToken(clerk, signal),
    ]);
    signal.throwIfAborted();
    if (!token) {
      throw new Error("Clerk token is required for the shared database");
    }
    const prepared = get(preparedSharedDatabaseBridgeState$);
    if (!prepared) {
      throw new Error("Shared database bridge was not prepared");
    }
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      prepared.bridge,
      async (recoverySignal) => {
        return await set(reloadToken$, recoverySignal);
      },
      signal,
    );
    prepared.authenticationRequiredTarget.addEventListener(
      AUTHENTICATION_REQUIRED_EVENT,
      onDomEventFn(async () => {
        await bridge.authenticationRequired();
      }),
      { signal },
    );
    const vercelProtectionBypass = getCapturedPreviewBypassForTarget(
      prepared.apiBaseUrl,
    );
    await set(
      installSharedDatabaseBridge$,
      bridge,
      {
        token,
        ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    connected.resolve(undefined);
    return token;
  },
);

export const setupSharedDatabaseBridge$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const connected = createDeferredPromise<void>(signal);
    set(setBridgeConnected$, connected.promise);
    const token = await onRejection(
      set(connectSharedDatabaseBridge$, connected, signal),
      (error) => {
        if (!connected.settled()) {
          connected.reject(error);
        }
      },
    );
    signal.throwIfAborted();
    if (!token) {
      return;
    }
    await set(runSharedDatabaseHeartbeatLoop$, token, signal);
    signal.throwIfAborted();
  },
);

export const heartbeatSharedDatabaseNow$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    const token = await readClerkToken(clerk, signal);
    signal.throwIfAborted();
    if (!token) {
      return;
    }
    const apiBaseUrl = resolveApiBaseForTarget("api");
    const vercelProtectionBypass =
      getCapturedPreviewBypassForTarget(apiBaseUrl);
    await set(
      heartbeatSharedDatabase$,
      {
        token,
        ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
      },
      signal,
    );
  },
);

const runSharedDatabaseHeartbeatLoop$ = command(
  async ({ set }, token: string, signal: AbortSignal): Promise<void> => {
    const heartbeatNow = onDomEventFn(async () => {
      await set(heartbeatSharedDatabaseNow$, signal);
    });
    const heartbeatWhenVisible = onDomEventFn(async () => {
      if (document.visibilityState === "visible") {
        await set(heartbeatSharedDatabaseNow$, signal);
      }
    });
    document.addEventListener("visibilitychange", heartbeatWhenVisible, {
      signal,
    });
    window.addEventListener("focus", heartbeatNow, { signal });

    const interval = heartbeatInterval(token);
    await delay(interval, { signal });
    await setLoop(
      async (loopSignal): Promise<boolean> => {
        await set(heartbeatSharedDatabaseNow$, loopSignal);
        await delay(interval, { signal: loopSignal });
        return false;
      },
      0,
      signal,
    );
  },
);
