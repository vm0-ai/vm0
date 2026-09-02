import { command, computed, state } from "ccstate";

import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import type { ComputedKey } from "./computed-key.ts";
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
      | "chat-thread-read-cursor-updated"
      | "invalidate"
      | "reconnect"
      | "reload-computed"
      | "reload-required"
      | "status";
  }
>;

const connectionControllersState$ = state<
  ReadonlyMap<ConnectionId, AbortController>
>(new Map());
const connectionPortsState$ = state<
  ReadonlyMap<ConnectionId, SharedDatabasePortLike>
>(new Map());

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
