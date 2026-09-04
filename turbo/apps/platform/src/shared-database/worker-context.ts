import { command, state } from "ccstate";

import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import type {
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "./bridge.ts";
import type { ComputedKey } from "./computed-key.ts";
import type {
  SharedDatabaseConnectionStatus,
  SharedDatabaseWorkerUnavailableReason,
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
      | "status"
      | "worker-unavailable";
  }
>;

const lastConnectionStatusState$ = state<SharedDatabaseConnectionStatus | null>(
  null,
);
const connectionControllersState$ = state<
  ReadonlyMap<ConnectionId, AbortController>
>(new Map());
interface RegisteredConnection {
  readonly getToken: SharedDatabaseTokenProvider;
  readonly port: SharedDatabasePortLike;
}

const connectionsState$ = state<
  ReadonlyMap<ConnectionId, RegisteredConnection>
>(new Map());

function deleteMapKey<TKey, TValue>(
  current: ReadonlyMap<TKey, TValue>,
  key: TKey,
): ReadonlyMap<TKey, TValue> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

export const broadcastSharedDatabaseWorkerMessage$ = command(
  ({ get }, message: WorkerBroadcastMessage): void => {
    for (const [connectionId, connection] of get(connectionsState$)) {
      L.debug("send message to app", connectionId, message);
      connection.port.postMessage(message);
    }
  },
);

const removeConnection$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    set(
      connectionControllersState$,
      deleteMapKey(get(connectionControllersState$), connectionId),
    );
    set(connectionsState$, deleteMapKey(get(connectionsState$), connectionId));
  },
);

export const registerConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    connectionController: AbortController,
    connection: RegisteredConnection,
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
      connectionsState$,
      new Map(get(connectionsState$)).set(connectionId, connection),
    );
    signal.addEventListener(
      "abort",
      () => {
        set(removeConnection$, connectionId);
      },
      { once: true },
    );
    // The Worker owns the realtime connection and boots without waiting for a
    // tab, so a tab that registers later has to be told the status it missed.
    const status = get(lastConnectionStatusState$);
    if (status) {
      connection.port.postMessage({ type: "status", status });
    }
    return signal;
  },
);

export const requestTokenFromFirstConnection$ = command(
  async ({ get }, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    const connection = get(connectionsState$).values().next().value;
    if (!connection) {
      throw new Error("Shared database token requires a registered tab");
    }
    return await connection.getToken(signal);
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

export const reportWorkerUnavailableForConnections$ = command(
  ({ set }, reason: SharedDatabaseWorkerUnavailableReason): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "worker-unavailable",
      reason,
    });
  },
);

export const updateRealtimeStatusForConnections$ = command(
  ({ set }, status: SharedDatabaseConnectionStatus): void => {
    set(lastConnectionStatusState$, status);
    set(broadcastSharedDatabaseWorkerMessage$, { type: "status", status });
  },
);
