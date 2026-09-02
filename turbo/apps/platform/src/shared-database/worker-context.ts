import { command, computed, state } from "ccstate";

import { now } from "../lib/time.ts";
import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { createDeferredPromise, withCleanup } from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import type { ComputedKey } from "./computed-key.ts";
import type { SharedDatabaseIdentity } from "./data-key.ts";
import type {
  SharedDatabaseConnectionStatus,
  SharedDatabaseWorkerMessage,
} from "./protocol.ts";

const L = logger("SharedWorkerBridge");

export type ConnectionId = string;

export type WorkerBroadcastMessage = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "authentication-required"
      | "chat-thread-read-cursor-updated"
      | "invalidate"
      | "reconnect"
      | "reload-computed"
      | "reload-required"
      | "status";
  }
>;

interface ActiveWorkerAuthRecovery {
  readonly recoveryId: string;
  readonly pendingConnectionIds: ReadonlySet<ConnectionId>;
  readonly deferred: ReturnType<typeof createDeferredPromise<string | null>>;
}

interface WorkerCredentialContext {
  readonly identity: SharedDatabaseIdentity;
}

const internalWorkerCredentialContext$ = state<WorkerCredentialContext | null>(
  null,
);
const connectionControllersState$ = state<
  ReadonlyMap<ConnectionId, AbortController>
>(new Map());
const connectionPortsState$ = state<
  ReadonlyMap<ConnectionId, SharedDatabasePortLike>
>(new Map());
const connectionLastHeartbeatAtState$ = state<
  ReadonlyMap<ConnectionId, number>
>(new Map());
// ccstate keeps this value isolated inside each credential Store.
const activeWorkerAuthRecoveryState$ = state<ActiveWorkerAuthRecovery | null>(
  null,
);

function requireWorkerCredentialContext(
  context: WorkerCredentialContext | null,
): WorkerCredentialContext {
  if (!context) {
    throw new Error("Worker credential context was not initialized");
  }
  return context;
}

function deleteMapKey<TKey, TValue>(
  current: ReadonlyMap<TKey, TValue>,
  key: TKey,
): ReadonlyMap<TKey, TValue> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

export const connectionControllers$ = computed((get) => {
  return get(connectionControllersState$);
});

export const connectionPorts$ = computed((get) => {
  return get(connectionPortsState$);
});

export const credentialStoreConnectionCount$ = computed((get): number => {
  return get(connectionControllersState$).size;
});

export const initializeWorkerCredentialContext$ = command(
  ({ get, set }, identity: SharedDatabaseIdentity): void => {
    if (get(internalWorkerCredentialContext$) !== null) {
      throw new Error("Worker credential context is already initialized");
    }
    set(internalWorkerCredentialContext$, { identity });
  },
);

export const broadcastSharedDatabaseWorkerMessage$ = command(
  ({ get }, message: WorkerBroadcastMessage): void => {
    for (const [connectionId, port] of get(connectionPortsState$)) {
      L.debug("send message to app", connectionId, message);
      port.postMessage(message);
    }
  },
);

function waitForWorkerAuthRecovery<T>(
  recovery: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([recovery, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Auth recovery settled", "AbortError"));
    }
  });
}

export const getWorkerToken$ = command(
  ({ get }, signal: AbortSignal): Promise<string | null> => {
    const activeRecovery = get(activeWorkerAuthRecoveryState$);
    if (activeRecovery) {
      return waitForWorkerAuthRecovery(activeRecovery.deferred.promise, signal);
    }
    signal.throwIfAborted();
    return Promise.resolve(
      requireWorkerCredentialContext(get(internalWorkerCredentialContext$))
        .identity.token,
    );
  },
);

export const forceRefreshWorkerToken$ = command(
  ({ get, set }, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    let activeRecovery = get(activeWorkerAuthRecoveryState$);
    if (!activeRecovery) {
      const pendingConnectionIds = new Set(get(connectionPortsState$).keys());
      if (pendingConnectionIds.size === 0) {
        return Promise.resolve(null);
      }
      const recoveryId = crypto.randomUUID();
      activeRecovery = {
        recoveryId,
        pendingConnectionIds,
        deferred: createDeferredPromise<string | null>(get(rootSignal$)),
      };
      set(activeWorkerAuthRecoveryState$, activeRecovery);
      set(broadcastSharedDatabaseWorkerMessage$, {
        type: "authentication-required",
        recoveryId,
      });
    }
    return waitForWorkerAuthRecovery(activeRecovery.deferred.promise, signal);
  },
);

const completeWorkerAuthRecoveryWithoutToken$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    const activeRecovery = get(activeWorkerAuthRecoveryState$);
    if (!activeRecovery?.pendingConnectionIds.has(connectionId)) {
      return;
    }
    const pendingConnectionIds = new Set(activeRecovery.pendingConnectionIds);
    pendingConnectionIds.delete(connectionId);
    if (pendingConnectionIds.size > 0) {
      set(activeWorkerAuthRecoveryState$, {
        ...activeRecovery,
        pendingConnectionIds,
      });
      return;
    }
    set(activeWorkerAuthRecoveryState$, null);
    activeRecovery.deferred.resolve(null);
  },
);

export const setWorkerToken$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    recoveryId: string,
    token: string | null,
  ): void => {
    const activeRecovery = get(activeWorkerAuthRecoveryState$);
    if (
      !activeRecovery ||
      activeRecovery.recoveryId !== recoveryId ||
      !activeRecovery.pendingConnectionIds.has(connectionId)
    ) {
      return;
    }
    if (token !== null) {
      const context = requireWorkerCredentialContext(
        get(internalWorkerCredentialContext$),
      );
      set(internalWorkerCredentialContext$, {
        identity: { ...context.identity, token },
      });
      set(activeWorkerAuthRecoveryState$, null);
      activeRecovery.deferred.resolve(token);
      return;
    }
    set(completeWorkerAuthRecoveryWithoutToken$, connectionId);
  },
);

const removeConnection$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    set(completeWorkerAuthRecoveryWithoutToken$, connectionId);
    set(
      connectionControllersState$,
      deleteMapKey(get(connectionControllersState$), connectionId),
    );
    set(
      connectionPortsState$,
      deleteMapKey(get(connectionPortsState$), connectionId),
    );
    set(
      connectionLastHeartbeatAtState$,
      deleteMapKey(get(connectionLastHeartbeatAtState$), connectionId),
    );
  },
);

export const registerConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    connectionController: AbortController,
    port: SharedDatabasePortLike,
    connectionControllerSignal: AbortSignal,
  ): AbortSignal => {
    connectionControllerSignal.throwIfAborted();
    if (get(connectionControllersState$).has(connectionId)) {
      throw new Error("Shared database connection is already registered");
    }
    const signal = AbortSignal.any([
      get(rootSignal$),
      connectionControllerSignal,
    ]);
    set(
      connectionControllersState$,
      new Map(get(connectionControllersState$)).set(
        connectionId,
        connectionController,
      ),
    );
    set(
      connectionPortsState$,
      new Map(get(connectionPortsState$)).set(connectionId, port),
    );
    set(
      connectionLastHeartbeatAtState$,
      new Map(get(connectionLastHeartbeatAtState$)).set(connectionId, now()),
    );
    signal.addEventListener(
      "abort",
      () => {
        set(removeConnection$, connectionId);
      },
      { once: true },
    );
    return signal;
  },
);

export const heartbeatConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    signal: AbortSignal,
    staleAfterMs: number,
  ): void => {
    signal.throwIfAborted();
    if (!get(connectionControllersState$).has(connectionId)) {
      throw new Error("Shared database connection is not registered");
    }
    const heartbeatAt = now();
    set(
      connectionLastHeartbeatAtState$,
      new Map(get(connectionLastHeartbeatAtState$)).set(
        connectionId,
        heartbeatAt,
      ),
    );
    for (const [otherConnectionId, lastHeartbeatAt] of get(
      connectionLastHeartbeatAtState$,
    )) {
      if (
        otherConnectionId !== connectionId &&
        lastHeartbeatAt < heartbeatAt - staleAfterMs
      ) {
        get(connectionControllersState$)
          .get(otherConnectionId)
          ?.abort(
            new DOMException(
              "Shared database connection heartbeat expired",
              "AbortError",
            ),
          );
      }
    }
  },
);

export const requireConnectionSignal$ = command(
  ({ get }, connectionId: ConnectionId, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (!get(connectionControllersState$).has(connectionId)) {
      throw new Error("Shared database connection is not registered");
    }
  },
);

export const reloadComputedForConnections$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "reload-computed",
      computedKey,
    });
  },
);

export const forwardChatThreadReadCursorUpdated$ = command(
  ({ set }, payload: unknown): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "chat-thread-read-cursor-updated",
      payload,
    });
  },
);

export const reloadConnections$ = command(({ set }): void => {
  set(broadcastSharedDatabaseWorkerMessage$, { type: "reload-required" });
});

export const updateRealtimeStatusForConnections$ = command(
  ({ set }, status: SharedDatabaseConnectionStatus): void => {
    set(broadcastSharedDatabaseWorkerMessage$, { type: "status", status });
  },
);
