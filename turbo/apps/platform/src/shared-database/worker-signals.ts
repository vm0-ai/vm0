import type { InboundMessage } from "ably";
import { command, computed, createStore, state, type Store } from "ccstate";

import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import { appVersion$, initializeAppVersion$ } from "../signals/app-version.ts";
import {
  setAuthenticatedIdentity$,
  setAuthRecovery$,
} from "../signals/auth-context.ts";
import { reloadChatIndicators$ } from "../signals/chat-thread-list-reload.ts";
import {
  setAblyLoop$,
  setAblyPayloadLoop$,
  setupRealtime$,
  subscribeRealtimeConnectionState$,
  type RealtimeConnectionState,
} from "../signals/realtime.ts";
import { rootSignal$, setRootSignal$ } from "../signals/root-signal.ts";
import type { AuthRecovery } from "../signals/auth-retry.ts";
import { createChildAbortController, settle } from "../signals/utils.ts";
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
  forceRefreshWorkerToken$,
  getWorkerToken$,
  heartbeatConnection$,
  initializeWorkerCredentialContext$,
  invalidateConnectionIndicators$,
  reloadConnections$,
  requireConnectionSignal$,
  setWorkerToken$,
  updateRealtimeStatusForConnections$,
  type ConnectionId,
  type WorkerBroadcastMessage,
} from "./worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "./worker-runtime.ts";
import { createSharedDatabaseContractClientFactory } from "./worker-client.ts";

const STALE_CONNECTION_AFTER_MS = 3 * 60 * 1000;

const credentialControllerState$ = state<AbortController | null>(null);
const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);
const credentialStoreDaemonsStartedState$ = state(false);
const sharedDatabaseClientFactory$ = computed((get) => {
  return createSharedDatabaseContractClientFactory(get(appVersion$));
});

interface CreateSharedDatabaseCredentialStoreOptions {
  readonly appVersion: string;
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass: string | undefined;
}

export interface InitializeCredentialStoreOptions {
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass: string | undefined;
  readonly onForceUpgrade: () => void;
}

interface CredentialStoreResources {
  readonly controller: AbortController;
  readonly runtime: SharedDatabaseWorkerRuntime;
  readonly authRecovery: AuthRecovery;
}

interface InitializeCredentialStoreResources {
  readonly controller: AbortController;
  readonly authRecovery: AuthRecovery;
  readonly broadcast: (message: WorkerBroadcastMessage) => void;
}

export type CredentialStoreDaemonOwner = (daemon: Promise<void>) => void;

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database credential Store is not bootstrapped");
  }
  return runtime;
}

const workerChatThreadIndicators$ = computed(
  async (get): Promise<ChatThreadIndicators> => {
    const indicators = await get(chatThreadIndicators$);
    const signal = get(rootSignal$);
    signal.throwIfAborted();
    const runtime = requireRuntime(get(workerRuntimeState$));
    await Promise.all(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        if (indicator !== "unread") {
          return [];
        }
        return [
          runtime.query(
            {
              dataKey: { kind: "chat-event", threadId },
              afterSeqId: null,
              consistency: "catch-up",
            },
            signal,
          ),
        ];
      }),
    );
    return indicators;
  },
);

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
    set(initializeWorkerCredentialContext$, options.identity);
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
    { get, set },
    resources: InitializeCredentialStoreResources,
    options: InitializeCredentialStoreOptions,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(setRootSignal$, signal);
    const runtime = new SharedDatabaseWorkerRuntime(
      {
        identity: options.identity,
        apiBaseUrl: options.apiBaseUrl,
        vercelProtectionBypass: options.vercelProtectionBypass,
        authRecovery: resources.authRecovery,
        emit: resources.broadcast,
        createContractClient: get(sharedDatabaseClientFactory$),
      },
      signal,
    );
    set(
      installCredentialStore$,
      {
        controller: resources.controller,
        runtime,
        authRecovery: resources.authRecovery,
      },
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
  store.set(initializeAppVersion$, options.appVersion);
  const credentialController = createChildAbortController(workerSignal);
  const credentialSignal = credentialController.signal;
  const authRecovery: AuthRecovery = {
    getToken: (signal) => {
      return store.set(getWorkerToken$, signal);
    },
    forceRefreshToken: (signal) => {
      return store.set(forceRefreshWorkerToken$, signal);
    },
  };
  const broadcast = (message: WorkerBroadcastMessage): void => {
    store.set(broadcastSharedDatabaseWorkerMessage$, message);
  };
  store.set(
    initializeCredentialStore$,
    { controller: credentialController, authRecovery, broadcast },
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

const reloadWorkerChatIndicators$ = command(
  async (
    { get, set },
    payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    set(reloadChatIndicators$);
    await get(workerChatThreadIndicators$);
    signal.throwIfAborted();
    set(invalidateConnectionIndicators$, payload);
    return false;
  },
);

const reloadWorkerChatIndicatorsFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    return await set(reloadWorkerChatIndicators$, null, signal);
  },
);

export const recoverCredentialStoreAfterRealtimeReconnect$ = command(
  ({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    set(broadcastSharedDatabaseReconnect$);
    set(reloadChatIndicators$);
    set(invalidateConnectionIndicators$, null);
  },
);

const runCredentialStoreDaemons$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
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
    const setup = await settle(set(setupRealtime$, signal), signal);
    if (!setup.ok) {
      set(updateSharedDatabaseRealtimeStatus$, "failed");
      return;
    }
    let initiallySubscribed = false;
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
                if (!initiallySubscribed) {
                  initiallySubscribed = true;
                  return;
                }
                set(broadcastSharedDatabaseReconnect$);
              },
            },
          },
          signal,
        ),
        set(
          setAblyLoop$,
          {
            scope: "credential",
            topic: "threadListChanged",
            loopCommand$: reloadWorkerChatIndicatorsFromRealtime$,
            options: {
              runOnForegroundCatchUp: false,
              runOnSubscribe: true,
            },
          },
          signal,
        ),
        set(
          setAblyPayloadLoop$,
          {
            scope: "credential",
            topic: "chatThreadReadCursorUpdated",
            loopCommand$: reloadWorkerChatIndicators$,
            options: { runOnForegroundCatchUp: false },
          },
          signal,
        ),
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
  ({ get, set }, ownDaemon: CredentialStoreDaemonOwner): void => {
    if (get(credentialStoreDaemonsStartedState$)) {
      return;
    }
    const signal = get(rootSignal$);
    set(credentialStoreDaemonsStartedState$, true);
    ownDaemon(set(runCredentialStoreDaemons$, signal));
  },
);

export const heartbeatSharedDatabaseWorker$ = command(
  (
    { set },
    connectionId: ConnectionId,
    signal: AbortSignal,
  ): SharedDatabaseHeartbeatResult => {
    set(heartbeatConnection$, connectionId, signal, STALE_CONNECTION_AFTER_MS);
    return { clientReconnected: false };
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
    const indicators = await get(workerChatThreadIndicators$);
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
type SetTokenMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "set-token" }
>;

export const heartbeatStoreMessage$ = command(
  (
    { set },
    connectionId: ConnectionId,
    _message: HeartbeatMessage,
    signal: AbortSignal,
  ): SharedDatabaseHeartbeatResult => {
    return set(heartbeatSharedDatabaseWorker$, connectionId, signal);
  },
);

export const setTokenStoreMessage$ = command(
  (
    { set },
    connectionId: ConnectionId,
    message: SetTokenMessage,
    signal: AbortSignal,
  ): void => {
    set(requireConnectionSignal$, connectionId, signal);
    set(setWorkerToken$, connectionId, message.recoveryId, message.token);
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
