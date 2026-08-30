import { command, state } from "ccstate";
import { delay } from "signal-timers";
import SharedDatabaseWorker from "virtual:shared-database-worker";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import { sentryLogContext } from "../lib/sentry-config.ts";
import { resolveApiBaseForTarget } from "./api-base.ts";
import { authRecovery$ } from "./auth.ts";
import type { AuthRecovery } from "./auth-retry.ts";
import { logger } from "./log.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  jsonParseOr,
  onDomEventFn,
  setLoop,
  settle,
  withCleanup,
} from "./utils.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import { AuthRecoveringSharedDatabaseBridge } from "../shared-database/auth-recovering-client.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../shared-database/bridge.ts";
import {
  ReconnectingSharedDatabaseBridge,
  SharedDatabaseTransportError,
  type SharedDatabaseTransportRecovery,
} from "../shared-database/reconnecting-client.ts";
import {
  heartbeatSharedDatabase$,
  installSharedDatabaseBridge$,
  sharedDatabaseBridgeInstalled$,
  setSharedDatabaseConnectionStatus$,
} from "./shared-database.ts";
import { reloadChatIndicators$ } from "./chat-thread-list-reload.ts";

const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const AUTHENTICATION_REQUIRED_EVENT = "authentication-required";
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

function isJavaScriptResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  return (
    contentType?.includes("javascript") === true ||
    contentType?.includes("ecmascript") === true
  );
}

async function waitForWorkerRetry(signal: AbortSignal): Promise<void> {
  const controller = createChildAbortController(signal);
  const ready = createDeferredPromise<void>(controller.signal);
  const resolve = (): void => {
    if (!ready.settled()) {
      ready.resolve();
    }
  };
  const resolveWhenVisible = (): void => {
    if (document.visibilityState === "visible") {
      resolve();
    }
  };
  window.addEventListener("online", resolve, { signal: controller.signal });
  window.addEventListener("focus", resolve, { signal: controller.signal });
  document.addEventListener("visibilitychange", resolveWhenVisible, {
    signal: controller.signal,
  });
  await withCleanup(ready.promise, () => {
    controller.abort(new DOMException("Worker retry resumed", "AbortError"));
  });
}

async function resolveWorkerRecovery(
  workerUrl: string,
  signal: AbortSignal,
): Promise<SharedDatabaseTransportRecovery> {
  if (!workerUrl) {
    await waitForWorkerRetry(signal);
    return "reconnect";
  }
  const probe = await settle(
    fetch(new URL(workerUrl, location.href), { cache: "no-store", signal }),
    signal,
  );
  if (!probe.ok) {
    await waitForWorkerRetry(signal);
    return "reconnect";
  }
  if (
    probe.value.status === 404 ||
    probe.value.status === 410 ||
    !isJavaScriptResponse(probe.value)
  ) {
    return "reload";
  }
  if (probe.value.ok) {
    return "reconnect";
  }
  await waitForWorkerRetry(signal);
  return "reconnect";
}

function createBrowserSharedDatabaseBridge(
  apiBaseUrl: string,
  events: SharedDatabaseBridgeEvents,
  signal: AbortSignal,
): SharedDatabaseBridge {
  const worker = new SharedDatabaseWorker({ name: "okou core service" });
  const portBridge = new MessagePortSharedDatabaseBridge(
    worker.port,
    apiBaseUrl,
    events,
  );
  let recoveryStarted = false;
  worker.addEventListener(
    "error",
    (event) => {
      if (recoveryStarted) {
        return;
      }
      recoveryStarted = true;
      const workerError: unknown = event.error;
      const workerUrl = event.filename;
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
        new SharedDatabaseTransportError(
          "Shared database worker failed to load",
          async () => {
            return await resolveWorkerRecovery(workerUrl, signal);
          },
        ),
      );
    },
    { signal },
  );
  return portBridge;
}

const sharedDatabaseBridgeHostState$ = state<SharedDatabaseBridgeHost>({
  createBridge: createBrowserSharedDatabaseBridge,
});

export const setSharedDatabaseBridgeHostForTest$ = command(
  ({ set }, host: SharedDatabaseBridgeHost): void => {
    set(sharedDatabaseBridgeHostState$, host);
  },
);

export const setupSharedDatabaseBridge$ = command(
  async (
    { get, set },
    authRecovery: AuthRecovery,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (get(sharedDatabaseBridgeInstalled$)) {
      return;
    }
    const token = await authRecovery.getToken(signal);
    signal.throwIfAborted();
    if (!token) {
      throw new Error("Clerk token is required for the shared database");
    }
    const apiBaseUrl = resolveApiBaseForTarget("api");
    const bridgeHost = get(sharedDatabaseBridgeHostState$);
    const authenticationRequiredTarget = new EventTarget();
    const reconnectingBridge = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        return bridgeHost.createBridge(apiBaseUrl, events, signal);
      },
      events: {
        authenticationRequired: () => {
          authenticationRequiredTarget.dispatchEvent(
            new Event(AUTHENTICATION_REQUIRED_EVENT),
          );
        },
        reloadRequired: () => {
          location.reload();
        },
        indicatorsInvalidated: () => {
          set(reloadChatIndicators$);
        },
        statusChanged: (status) => {
          set(setSharedDatabaseConnectionStatus$, status);
        },
      },
    });
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      reconnectingBridge,
      async (recoverySignal) => {
        return await authRecovery.forceRefreshToken(recoverySignal);
      },
      signal,
    );
    authenticationRequiredTarget.addEventListener(
      AUTHENTICATION_REQUIRED_EVENT,
      onDomEventFn(async () => {
        await bridge.authenticationRequired();
      }),
      { signal },
    );
    const vercelProtectionBypass =
      getCapturedPreviewBypassForTarget(apiBaseUrl);
    await set(
      installSharedDatabaseBridge$,
      bridge,
      {
        token,
        ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
      },
      signal,
    );
  },
);

export const heartbeatSharedDatabaseNow$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const authRecovery = await get(authRecovery$);
    signal.throwIfAborted();

    const token = await authRecovery.getToken(signal);
    signal.throwIfAborted();
    if (!token) {
      throw new Error("Clerk token is required for the shared database");
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

export const runSharedDatabaseHeartbeatLoop$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const authRecovery = await get(authRecovery$);
    signal.throwIfAborted();
    const token = await authRecovery.getToken(signal);
    signal.throwIfAborted();
    if (!token) {
      throw new Error("Clerk token is required for the shared database");
    }
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
