import { command, computed, state } from "ccstate";

import { now } from "../lib/time.ts";
import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { createDeferredPromise, withCleanup } from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
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
      | "indicators-invalidated"
      | "invalidate"
      | "reconnect"
      | "reload-required"
      | "status";
  }
>;

interface TokenWaiter {
  readonly rejectedToken: string;
  readonly deferred: ReturnType<typeof createDeferredPromise<string | null>>;
}

export class WorkerTokenRecovery {
  private readonly waiters = new Set<TokenWaiter>();

  constructor(
    private token: string,
    private readonly broadcast: (message: WorkerBroadcastMessage) => void,
  ) {}

  getToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return Promise.resolve(this.token);
  }

  reloadToken(signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    this.broadcast({ type: "authentication-required" });
    const waiter: TokenWaiter = {
      rejectedToken: this.token,
      deferred: createDeferredPromise<string | null>(signal),
    };
    this.waiters.add(waiter);
    return withCleanup(waiter.deferred.promise, () => {
      this.waiters.delete(waiter);
    });
  }

  updateToken(token: string): void {
    this.token = token;
    for (const waiter of this.waiters) {
      if (waiter.rejectedToken !== token && !waiter.deferred.settled()) {
        waiter.deferred.resolve(token);
      }
    }
  }
}

interface WorkerCredentialContext {
  readonly identity: SharedDatabaseIdentity;
  readonly tokenRecovery: WorkerTokenRecovery;
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

export const workerCredentialIdentity$ = computed((get) => {
  return requireWorkerCredentialContext(get(internalWorkerCredentialContext$))
    .identity;
});

export const workerTokenRecovery$ = computed((get) => {
  return requireWorkerCredentialContext(get(internalWorkerCredentialContext$))
    .tokenRecovery;
});

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
  (
    { get, set },
    identity: SharedDatabaseIdentity,
    tokenRecovery: WorkerTokenRecovery,
  ): void => {
    if (get(internalWorkerCredentialContext$) !== null) {
      throw new Error("Worker credential context is already initialized");
    }
    set(internalWorkerCredentialContext$, { identity, tokenRecovery });
  },
);

export const updateWorkerCredentialIdentity$ = command(
  ({ get, set }, identity: SharedDatabaseIdentity): void => {
    const context = requireWorkerCredentialContext(
      get(internalWorkerCredentialContext$),
    );
    if (
      context.identity.userId !== identity.userId ||
      context.identity.orgId !== identity.orgId
    ) {
      throw new Error("Worker credential Store identity cannot change");
    }
    context.tokenRecovery.updateToken(identity.token);
    set(internalWorkerCredentialContext$, {
      identity,
      tokenRecovery: context.tokenRecovery,
    });
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

const removeConnection$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
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

export const invalidateConnectionIndicators$ = command(
  ({ set }, payload: unknown): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "indicators-invalidated",
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
