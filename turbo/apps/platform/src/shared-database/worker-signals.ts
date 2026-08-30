import { command, state } from "ccstate";
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
  SharedDatabaseWorkerRuntime,
  type WorkerClientEmitter,
} from "./worker-runtime.ts";
import { setRootSignal$ } from "../signals/root-signal.ts";
import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import {
  setAuthenticatedIdentity$,
  setAuthRecovery$,
} from "../signals/auth-context.ts";
import {
  initializeWorkerCredentialContext$,
  registerTab$,
  unregisterTab$,
  type TabId,
} from "./worker-context.ts";
import { setupRealtime$ } from "../signals/realtime.ts";
import {
  subscribeChatThreadReadCursorUpdated$,
  subscribeThreadListChanged$,
} from "../signals/chat-thread-list-reload.ts";
import { chatThreadIndicators$ } from "../signals/chat-page/chat-thread-indicators.ts";

const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);

interface SharedDatabaseWorkerHeartbeat {
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
  readonly emit?: WorkerClientEmitter;
}

interface InitializeCredentialStore {
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
  readonly onForceUpgrade: () => void;
}

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database worker is not bootstrapped");
  }
  return runtime;
}

export const bootstrapSharedDatabaseWorker$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    if (get(workerRuntimeState$)) {
      return;
    }
    set(workerRuntimeState$, new SharedDatabaseWorkerRuntime(signal));
  },
);

export const initializeCredentialStore$ = command(
  (
    { get, set },
    input: InitializeCredentialStore,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(setRootSignal$, signal);
    set(setApiClientRuntime$, {
      apiBaseUrl: input.apiBaseUrl,
      oauthApiBaseUrl: input.apiBaseUrl,
      ...(input.vercelProtectionBypass
        ? { vercelProtectionBypass: input.vercelProtectionBypass }
        : {}),
      onForceUpgrade: input.onForceUpgrade,
    });
    const authRecovery = set(
      initializeWorkerCredentialContext$,
      input.identity,
    );
    set(setAuthRecovery$, Promise.resolve(authRecovery));
    set(setAuthenticatedIdentity$, Promise.resolve(input.identity));
    if (get(workerRuntimeState$) === null) {
      set(bootstrapSharedDatabaseWorker$, signal);
    }
  },
);

export const runCredentialStoreDaemons$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    await Promise.all([
      set(subscribeThreadListChanged$, signal),
      set(subscribeChatThreadReadCursorUpdated$, signal),
    ]);
  },
);

export const readWorkerChatThreadIndicators$ = command(
  async ({ get }, signal: AbortSignal): Promise<ChatThreadIndicators> => {
    const indicators = await get(chatThreadIndicators$);
    signal.throwIfAborted();
    return indicators;
  },
);

export const connectSharedDatabaseWorkerClient$ = command(
  ({ get }, clientId: string, emit: WorkerClientEmitter): void => {
    requireRuntime(get(workerRuntimeState$)).connectClient(clientId, emit);
  },
);

export const registerSharedDatabaseWorkerTab$ = command(
  ({ get, set }, tabId: TabId, emit: WorkerClientEmitter): void => {
    const runtime = requireRuntime(get(workerRuntimeState$));
    runtime.connectClient(String(tabId), emit);
    set(registerTab$, tabId, emit);
  },
);

export const unregisterSharedDatabaseWorkerTab$ = command(
  ({ get, set }, tabId: TabId): number => {
    requireRuntime(get(workerRuntimeState$)).disconnectClient(String(tabId));
    return set(unregisterTab$, tabId);
  },
);

export const heartbeatSharedDatabaseWorker$ = command(
  async (
    { get },
    clientId: string,
    heartbeat: SharedDatabaseWorkerHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> => {
    signal.throwIfAborted();
    const result = await requireRuntime(get(workerRuntimeState$)).heartbeat(
      clientId,
      heartbeat.emit,
      heartbeat.identity,
      heartbeat.apiBaseUrl,
      heartbeat.vercelProtectionBypass,
    );
    signal.throwIfAborted();
    return result;
  },
);

export const subscribeSharedDatabaseWorker$ = command(
  (
    { get },
    clientId: string,
    subscriptionId: string,
    dataKey: SharedDatabaseDataKey,
  ): void => {
    requireRuntime(get(workerRuntimeState$)).subscribe(
      clientId,
      subscriptionId,
      dataKey,
    );
  },
);

export const unsubscribeSharedDatabaseWorker$ = command(
  ({ get }, clientId: string, subscriptionId: string): void => {
    requireRuntime(get(workerRuntimeState$)).unsubscribe(
      clientId,
      subscriptionId,
    );
  },
);

export const querySharedDatabaseWorker$ = command(
  async (
    { get },
    clientId: string,
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await requireRuntime(get(workerRuntimeState$)).query(
      clientId,
      query,
      signal,
    );
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
type SubscribeMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "subscribe" }
>;
type UnsubscribeMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "unsubscribe" }
>;
type IndicatorsMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-indicators" }
>;

interface HeartbeatStoreMessage {
  readonly message: HeartbeatMessage;
  readonly identity: SharedDatabaseIdentity;
  readonly emit: WorkerClientEmitter;
  readonly register: boolean;
  readonly onForceUpgrade: () => void;
}

export const heartbeatStoreMessage$ = command(
  async (
    { set },
    tabId: TabId,
    input: HeartbeatStoreMessage,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> => {
    set(
      initializeCredentialStore$,
      {
        identity: input.identity,
        apiBaseUrl: input.message.apiBaseUrl,
        ...(input.message.vercelProtectionBypass
          ? {
              vercelProtectionBypass: input.message.vercelProtectionBypass,
            }
          : {}),
        onForceUpgrade: input.onForceUpgrade,
      },
      signal,
    );
    if (input.register) {
      set(registerSharedDatabaseWorkerTab$, tabId, input.emit);
    }
    const result = await set(
      heartbeatSharedDatabaseWorker$,
      String(tabId),
      {
        identity: input.identity,
        apiBaseUrl: input.message.apiBaseUrl,
        emit: input.emit,
        ...(input.message.vercelProtectionBypass
          ? {
              vercelProtectionBypass: input.message.vercelProtectionBypass,
            }
          : {}),
      },
      signal,
    );
    return {
      clientReconnected: input.register || result.clientReconnected,
    };
  },
);

export const queryStoreMessage$ = command(
  async (
    { set },
    tabId: TabId,
    message: QueryMessage,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await set(
      querySharedDatabaseWorker$,
      String(tabId),
      message.query,
      signal,
    );
  },
);

export const subscribeStoreMessage$ = command(
  (
    { set },
    tabId: TabId,
    message: SubscribeMessage,
    _signal: AbortSignal,
  ): void => {
    set(
      subscribeSharedDatabaseWorker$,
      String(tabId),
      message.subscriptionId,
      message.dataKey,
    );
  },
);

export const unsubscribeStoreMessage$ = command(
  (
    { set },
    tabId: TabId,
    message: UnsubscribeMessage,
    _signal: AbortSignal,
  ): void => {
    set(
      unsubscribeSharedDatabaseWorker$,
      String(tabId),
      message.subscriptionId,
    );
  },
);

export const indicatorsStoreMessage$ = command(
  async (
    { set },
    _tabId: TabId,
    _message: IndicatorsMessage,
    signal: AbortSignal,
  ): Promise<ChatThreadIndicators> => {
    return await set(readWorkerChatThreadIndicators$, signal);
  },
);
