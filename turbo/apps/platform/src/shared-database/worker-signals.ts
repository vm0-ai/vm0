import type { InboundMessage } from "ably";
import { command, createStore, state, type Store } from "ccstate";

import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import {
  setAuthenticatedIdentity$,
  setAuthRecovery$,
} from "../signals/auth-context.ts";
import {
  reloadChatIndicators$,
  reloadChatIndicatorsFromRealtime$,
  subscribeChatThreadReadCursorUpdated$,
  subscribeThreadListChanged$,
} from "../signals/chat-thread-list-reload.ts";
import {
  setAblyPayloadLoop$,
  setupRealtime$,
  subscribeRealtimeConnectionState$,
  type RealtimeConnectionState,
} from "../signals/realtime.ts";
import { rootSignal$, setRootSignal$ } from "../signals/root-signal.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  Reason,
  settle,
} from "../signals/utils.ts";
import { chatThreadIndicators$ } from "../signals/chat-page/chat-thread-indicators.ts";
import type {
  ChatThreadIndicators,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseClientMessage,
  SharedDatabaseHeartbeatResult,
} from "./protocol.ts";
import {
  broadcastSharedDatabaseWorkerMessage$,
  heartbeatConnection$,
  initializeWorkerCredentialContext$,
  invalidateConnectionIndicators$,
  reloadConnections$,
  requireConnectionSignal$,
  updateRealtimeStatusForConnections$,
  updateWorkerCredentialIdentity$,
  WorkerAuthRecovery,
  type ConnectionId,
  type WorkerBroadcastMessage,
} from "./worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "./worker-runtime.ts";

const STALE_CONNECTION_AFTER_MS = 3 * 60 * 1000;

const credentialControllerState$ = state<AbortController | null>(null);
const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);
const credentialStoreDaemonsReadyState$ = state<Promise<void> | null>(null);

interface CreateSharedDatabaseCredentialStoreOptions {
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass: string | undefined;
}

export interface InitializeCredentialStoreOptions extends CreateSharedDatabaseCredentialStoreOptions {
  readonly onForceUpgrade: () => void;
}

interface SharedDatabaseWorkerHeartbeat {
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
}

interface CredentialStoreResources {
  readonly controller: AbortController;
  readonly runtime: SharedDatabaseWorkerRuntime;
  readonly authRecovery: WorkerAuthRecovery;
}

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database credential Store is not bootstrapped");
  }
  return runtime;
}

function sharedDatabaseConnectionStatus(
  state: RealtimeConnectionState,
): "connected" | "connecting" | "disconnected" {
  if (state === "connected") {
    return "connected";
  }
  if (state === "closed" || state === "closing" || state === "failed") {
    return "disconnected";
  }
  return "connecting";
}

function isInboundMessage(value: unknown): value is InboundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("name" in value) ||
      value.name === undefined ||
      typeof value.name === "string")
  );
}

const installCredentialStore$ = command(
  (
    { set },
    resources: CredentialStoreResources,
    options: InitializeCredentialStoreOptions,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(credentialControllerState$, resources.controller);
    set(workerRuntimeState$, resources.runtime);
    set(
      initializeWorkerCredentialContext$,
      options.identity,
      resources.authRecovery,
    );
    set(setApiClientRuntime$, {
      environment: "worker",
      apiBaseUrl: options.apiBaseUrl,
      oauthApiBaseUrl: options.apiBaseUrl,
      ...(options.vercelProtectionBypass
        ? { vercelProtectionBypass: options.vercelProtectionBypass }
        : {}),
      onForceUpgrade: options.onForceUpgrade,
    });
    set(setAuthRecovery$, Promise.resolve(resources.authRecovery));
    set(setAuthenticatedIdentity$, Promise.resolve(options.identity));
  },
);

export const initializeCredentialStore$ = command(
  (
    { set },
    controller: AbortController,
    options: InitializeCredentialStoreOptions,
    broadcast: (message: WorkerBroadcastMessage) => void,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(setRootSignal$, signal);
    const authRecovery = new WorkerAuthRecovery(
      options.identity.token,
      broadcast,
    );
    const runtime = new SharedDatabaseWorkerRuntime(
      options.identity,
      options.apiBaseUrl,
      options.vercelProtectionBypass,
      signal,
      broadcast,
    );
    set(
      installCredentialStore$,
      { controller, runtime, authRecovery },
      options,
      signal,
    );
  },
);

export function createSharedDatabaseCredentialStore(
  options: CreateSharedDatabaseCredentialStoreOptions,
  workerSignal: AbortSignal,
): Store {
  const store = createStore();
  const credentialController = createChildAbortController(workerSignal);
  const credentialSignal = credentialController.signal;
  const broadcast = (message: WorkerBroadcastMessage): void => {
    store.set(broadcastSharedDatabaseWorkerMessage$, message);
  };
  store.set(
    initializeCredentialStore$,
    credentialController,
    {
      ...options,
      onForceUpgrade: () => {
        store.set(reloadConnections$);
        credentialController.abort(
          new DOMException(
            "Credential Store requires a newer client",
            "AbortError",
          ),
        );
      },
    },
    broadcast,
    credentialSignal,
  );
  return store;
}

const updateSharedDatabaseRealtimeStatus$ = command(
  ({ set }, state: RealtimeConnectionState): void => {
    set(
      updateRealtimeStatusForConnections$,
      sharedDatabaseConnectionStatus(state),
    );
  },
);

const broadcastSharedDatabaseReconnect$ = command(({ set }): boolean => {
  set(broadcastSharedDatabaseWorkerMessage$, { type: "reconnect" });
  return false;
});

export const handleSharedDatabaseRealtimeMessage$ = command(
  ({ set }, payload: unknown, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    if (!isInboundMessage(payload)) {
      throw new Error("Shared database realtime message is invalid");
    }
    const topic = payload.name ?? "";
    const threadId = topic.startsWith("chatThreadMessageCreated:")
      ? topic.slice("chatThreadMessageCreated:".length)
      : null;
    const dataKey: SharedDatabaseDataKey | null =
      threadId !== null && threadId.length > 0
        ? { kind: "chat-event", threadId }
        : topic === "threadListChanged"
          ? { kind: "chat-thread-event" }
          : null;
    if (dataKey) {
      set(broadcastSharedDatabaseWorkerMessage$, {
        type: "invalidate",
        dataKey,
      });
    }
    return false;
  },
);

export const recoverCredentialStoreAfterRealtimeReconnect$ = command(
  ({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    set(broadcastSharedDatabaseReconnect$);
    set(reloadChatIndicatorsFromRealtime$);
  },
);

const runCredentialStoreDaemons$ = command(
  async (
    { set },
    ready: ReturnType<typeof createDeferredPromise<void>>,
    signal: AbortSignal,
  ): Promise<void> => {
    set(
      subscribeRealtimeConnectionState$,
      ({ state, reconnected }) => {
        set(updateSharedDatabaseRealtimeStatus$, state);
        if (reconnected) {
          set(recoverCredentialStoreAfterRealtimeReconnect$, signal);
        }
      },
      signal,
    );
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    const subscriptions = await settle(
      Promise.all([
        set(
          setAblyPayloadLoop$,
          {
            scope: "credential",
            topic: null,
            loopCommand$: handleSharedDatabaseRealtimeMessage$,
            includeMessage: true,
            options: {
              onSubscribed: () => {
                if (!ready.settled()) {
                  ready.resolve();
                  return;
                }
                set(broadcastSharedDatabaseReconnect$);
              },
            },
          },
          signal,
        ),
        set(subscribeThreadListChanged$, signal),
        set(subscribeChatThreadReadCursorUpdated$, signal),
      ]),
      signal,
    );
    signal.throwIfAborted();
    if (!subscriptions.ok) {
      set(updateSharedDatabaseRealtimeStatus$, "failed");
    }
  },
);

export const startCredentialStoreDaemons$ = command(
  ({ get, set }): Promise<void> => {
    const existing = get(credentialStoreDaemonsReadyState$);
    if (existing) {
      return existing;
    }
    const signal = get(rootSignal$);
    const ready = createDeferredPromise<void>(signal);
    set(credentialStoreDaemonsReadyState$, ready.promise);
    detach(
      set(runCredentialStoreDaemons$, ready, signal),
      Reason.Daemon,
      "shared database credential daemons",
    );
    return ready.promise;
  },
);

export const heartbeatSharedDatabaseWorker$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    heartbeat: SharedDatabaseWorkerHeartbeat,
    signal: AbortSignal,
  ): SharedDatabaseHeartbeatResult => {
    set(heartbeatConnection$, connectionId, signal, STALE_CONNECTION_AFTER_MS);
    set(updateWorkerCredentialIdentity$, heartbeat.identity);
    set(setAuthenticatedIdentity$, Promise.resolve(heartbeat.identity));
    return requireRuntime(get(workerRuntimeState$)).heartbeat(
      heartbeat.identity,
      heartbeat.apiBaseUrl,
      heartbeat.vercelProtectionBypass,
    );
  },
);

export const querySharedDatabaseWorker$ = command(
  async (
    { get, set },
    connectionId: ConnectionId,
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    set(requireConnectionSignal$, connectionId, signal);
    return await requireRuntime(get(workerRuntimeState$)).query(query, signal);
  },
);

export const readWorkerChatThreadIndicators$ = command(
  async ({ get }, signal: AbortSignal): Promise<ChatThreadIndicators> => {
    const indicators = await get(chatThreadIndicators$);
    signal.throwIfAborted();
    return indicators;
  },
);

type HeartbeatMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "heartbeat" }
>;
type QueryMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "query" }
>;
type IndicatorsMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-indicators" }
>;
type ReloadIndicatorsMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "reload-indicators" }
>;

export const heartbeatStoreMessage$ = command(
  (
    { set },
    connectionId: ConnectionId,
    message: HeartbeatMessage,
    identity: SharedDatabaseIdentity,
    signal: AbortSignal,
  ): SharedDatabaseHeartbeatResult => {
    return set(
      heartbeatSharedDatabaseWorker$,
      connectionId,
      {
        identity,
        apiBaseUrl: message.apiBaseUrl,
        ...(message.vercelProtectionBypass
          ? { vercelProtectionBypass: message.vercelProtectionBypass }
          : {}),
      },
      signal,
    );
  },
);

export const queryStoreMessage$ = command(
  async (
    { set },
    connectionId: ConnectionId,
    message: QueryMessage,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await set(
      querySharedDatabaseWorker$,
      connectionId,
      message.query,
      signal,
    );
  },
);

export const indicatorsStoreMessage$ = command(
  async (
    { set },
    connectionId: ConnectionId,
    _message: IndicatorsMessage,
    signal: AbortSignal,
  ): Promise<ChatThreadIndicators> => {
    set(requireConnectionSignal$, connectionId, signal);
    return await set(readWorkerChatThreadIndicators$, signal);
  },
);

export const reloadIndicatorsStoreMessage$ = command(
  (
    { set },
    _connectionId: ConnectionId,
    _message: ReloadIndicatorsMessage,
  ): void => {
    set(reloadChatIndicators$);
    set(invalidateConnectionIndicators$, null);
  },
);

export const disposeSharedDatabaseCredentialStore$ = command(
  ({ get }): void => {
    get(credentialControllerState$)?.abort(
      new DOMException(
        "Shared database credential Store disposed",
        "AbortError",
      ),
    );
  },
);
