import { command } from "ccstate";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { resolveApiBaseForTarget } from "./api-base.ts";
import { authRecovery$, authenticatedIdentity$ } from "./auth.ts";
import { createDeferredPromise, jsonParseOr, setLoop } from "./utils.ts";
import { MessagePortSharedDatabaseBridge } from "../shared-database/message-port-client.ts";
import { ReconnectingSharedDatabaseBridge } from "../shared-database/reconnecting-client.ts";
import {
  heartbeatSharedDatabase$,
  installSharedDatabaseBridge$,
  sharedDatabaseBridgeInstalled$,
  setSharedDatabaseConnectionStatus$,
} from "./shared-database.ts";

const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

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

export const setupSharedDatabaseBridge$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (get(sharedDatabaseBridgeInstalled$)) {
      return;
    }
    const apiBaseUrl = resolveApiBaseForTarget("api");
    const bridge = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        const worker = new SharedWorker(
          new URL("../shared-database-worker.ts", import.meta.url),
          { type: "module" },
        );
        return new MessagePortSharedDatabaseBridge(
          worker.port,
          apiBaseUrl,
          events,
        );
      },
      events: {
        reloadRequired: () => {
          location.reload();
        },
        statusChanged: (status) => {
          set(setSharedDatabaseConnectionStatus$, status);
        },
      },
    });
    set(installSharedDatabaseBridge$, bridge);
  },
);

export const heartbeatSharedDatabaseNow$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const authRecovery = await get(authRecovery$);
    signal.throwIfAborted();

    const token = await authRecovery.getToken(signal);
    signal.throwIfAborted();
    if (!token) {
      throw new Error("Clerk token is required for the shared database");
    }
    await set(
      heartbeatSharedDatabase$,
      {
        userId: identity.userId,
        orgId: identity.orgId,
        token,
      },
      signal,
    );
  },
);

export const runSharedDatabaseHeartbeatLoop$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (IN_VITEST) {
      return;
    }
    const authRecovery = await get(authRecovery$);
    signal.throwIfAborted();
    let wake = createDeferredPromise<void>(signal);
    const wakeNow = (): void => {
      if (!wake.settled()) {
        wake.resolve(undefined);
      }
    };
    const wakeWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        wakeNow();
      }
    };
    document.addEventListener("visibilitychange", wakeWhenVisible);
    window.addEventListener("focus", wakeNow);
    signal.addEventListener(
      "abort",
      () => {
        document.removeEventListener("visibilitychange", wakeWhenVisible);
        window.removeEventListener("focus", wakeNow);
      },
      { once: true },
    );

    await setLoop(
      async (loopSignal): Promise<boolean> => {
        const token = await authRecovery.getToken(loopSignal);
        loopSignal.throwIfAborted();
        if (!token) {
          throw new Error("Clerk token is required for the shared database");
        }
        await Promise.race([
          delay(heartbeatInterval(token), { signal: loopSignal }),
          wake.promise,
        ]);
        if (!wake.settled()) {
          wake.resolve(undefined);
        }
        wake = createDeferredPromise<void>(loopSignal);
        await set(heartbeatSharedDatabaseNow$, signal);
        return false;
      },
      0,
      signal,
    );
  },
);
