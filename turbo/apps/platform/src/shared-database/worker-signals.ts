import type { InboundMessage } from "ably";
import { command, computed, state } from "ccstate";

import {
  derivePlatformServiceOrigin,
  resolvePlatformEnvironment,
} from "../lib/platform-host.ts";
import { VERCEL_PROTECTION_BYPASS_NAME } from "../lib/preview-bypass-name.ts";
import { apiClient$ } from "../signals/api-client.ts";
import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import { initializeAppVersion$ } from "../signals/app-version.ts";
import { setAuthenticatedIdentity$ } from "../signals/auth-context.ts";
import type { ClerkTokenSource } from "../signals/clerk-token.ts";
import { reloadChatIndicators$ } from "../signals/chat-thread-list-reload.ts";
import {
  computerUseHosts$,
  reloadComputerUseHosts$,
} from "../signals/external/computer-use-hosts.ts";
import {
  queueData$,
  reloadQueueData$,
} from "../signals/queue-page/queue-signals.ts";
import {
  setAblyLoop$,
  setAblyPayloadLoop$,
  setupRealtime$,
  subscribeRealtimeConnectionState$,
  type RealtimeConnectionState,
} from "../signals/realtime.ts";
import { rootSignal$, setRootSignal$ } from "../signals/root-signal.ts";
import { settle } from "../signals/utils.ts";
import { startWorkerClerk$ } from "../signals/worker-auth.ts";
import { chatThreadIndicators$ } from "../signals/chat-page/chat-thread-indicators.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import {
  sharedDatabaseIdentitySchema,
  type ChatThreadIndicators,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { SharedDatabaseClientMessage } from "./protocol.ts";
import {
  broadcastSharedDatabaseWorkerMessage$,
  forwardChatThreadReadCursorUpdated$,
  reloadComputedForConnections$,
  reloadConnections$,
  requireConnectionSignal$,
  updateRealtimeStatusForConnections$,
  type ConnectionId,
} from "./worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "./worker-runtime.ts";

const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);
const workerDaemonsStartedState$ = state(false);

export interface BootstrapSharedDatabaseWorkerOptions {
  readonly appVersion: string;
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly clerk: Promise<ClerkTokenSource>;
  readonly oauthApiBaseUrl: string;
  readonly onForceUpgrade: () => void;
  readonly vercelProtectionBypass?: string;
}

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database Worker Store is not bootstrapped");
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
      Object.keys(indicators.threads).map((threadId) => {
        return runtime.query(
          {
            dataKey: { kind: "chat-event", threadId },
            afterSeqId: null,
            consistency: "catch-up",
          },
          signal,
        );
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

export const initializeSharedDatabaseWorker$ = command(
  (
    { get, set },
    options: BootstrapSharedDatabaseWorkerOptions,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(initializeAppVersion$, options.appVersion);
    set(setRootSignal$, signal);
    set(setApiClientRuntime$, {
      clerk: options.clerk,
      environment: "worker",
      apiBaseUrl: options.apiBaseUrl,
      oauthApiBaseUrl: options.oauthApiBaseUrl,
      ...(options.vercelProtectionBypass
        ? { vercelProtectionBypass: options.vercelProtectionBypass }
        : {}),
      onForceUpgrade: options.onForceUpgrade,
    });
    set(setAuthenticatedIdentity$, Promise.resolve(options.identity));
    const runtime = new SharedDatabaseWorkerRuntime(
      {
        identity: options.identity,
        emit: (message) => {
          set(broadcastSharedDatabaseWorkerMessage$, message);
        },
        createContractClient: get(apiClient$),
      },
      signal,
    );
    set(workerRuntimeState$, runtime);
  },
);

export const bootstrapSharedDatabaseWorkerStore$ = command(
  (
    { set },
    options: BootstrapSharedDatabaseWorkerOptions,
    signal: AbortSignal,
  ): Promise<void> | null => {
    set(initializeSharedDatabaseWorker$, options, signal);
    return set(startSharedDatabaseWorkerDaemons$);
  },
);

function resolveWorkerIdentity(): SharedDatabaseIdentity {
  const params = new URL(location.href).searchParams;
  return sharedDatabaseIdentitySchema.parse({
    userId: params.get("userId"),
    orgId: params.get("orgId"),
  });
}

export const bootstrapWorker$ = command(
  ({ set }, signal: AbortSignal): Promise<void> | null => {
    const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
    const vercelProtectionBypass = new URL(location.href).searchParams.get(
      VERCEL_PROTECTION_BYPASS_NAME,
    );
    const oauthApiBaseUrl =
      resolvePlatformEnvironment() === "production"
        ? derivePlatformServiceOrigin(location.origin, "www")
        : apiBaseUrl;
    return set(
      bootstrapSharedDatabaseWorkerStore$,
      {
        appVersion: __OKOU_APP_VERSION__,
        identity: resolveWorkerIdentity(),
        apiBaseUrl,
        clerk: set(startWorkerClerk$, signal),
        oauthApiBaseUrl,
        onForceUpgrade: () => {
          set(reloadConnections$);
        },
        ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
      },
      signal,
    );
  },
);

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

const reloadWorkerComputed$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    if (computedKey === "chat-thread-indicators") {
      set(reloadChatIndicators$);
      return;
    }
    if (computedKey === "computer-use-hosts") {
      set(reloadComputerUseHosts$);
      return;
    }
    set(reloadQueueData$);
  },
);

const refreshWorkerChatIndicators$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "chat-thread-indicators");
    await get(workerChatThreadIndicators$);
    signal.throwIfAborted();
  },
);

export const reloadWorkerChatIndicatorsFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    return false;
  },
);

export const reloadWorkerChatIndicatorsFromReadCursor$ = command(
  async ({ set }, payload: unknown, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(forwardChatThreadReadCursorUpdated$, payload);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    return false;
  },
);

export const reloadWorkerComputerUseHostsFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "computer-use-hosts");
    set(reloadComputedForConnections$, "computer-use-hosts");
    return false;
  },
);

export const reloadWorkerQueueDataFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "queue-data");
    set(reloadComputedForConnections$, "queue-data");
    return false;
  },
);

export const recoverSharedDatabaseWorkerAfterRealtimeReconnect$ = command(
  ({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    set(broadcastSharedDatabaseReconnect$);
    set(reloadWorkerComputed$, "chat-thread-indicators");
    set(reloadWorkerComputed$, "computer-use-hosts");
    set(reloadWorkerComputed$, "queue-data");
    set(reloadComputedForConnections$, "chat-thread-indicators");
    set(reloadComputedForConnections$, "computer-use-hosts");
    set(reloadComputedForConnections$, "queue-data");
  },
);

const runSharedDatabaseWorkerDaemons$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    set(
      subscribeRealtimeConnectionState$,
      ({ state, reconnected }) => {
        set(updateSharedDatabaseRealtimeStatus$, state);
        if (reconnected) {
          set(recoverSharedDatabaseWorkerAfterRealtimeReconnect$, signal);
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
            loopCommand$: reloadWorkerChatIndicatorsFromReadCursor$,
            options: { runOnForegroundCatchUp: false },
          },
          signal,
        ),
        set(
          setAblyLoop$,
          {
            scope: "user",
            topic: "computerUseHostsChanged",
            loopCommand$: reloadWorkerComputerUseHostsFromRealtime$,
            options: {
              runOnForegroundCatchUp: false,
              runOnSubscribe: true,
            },
          },
          signal,
        ),
        set(
          setAblyLoop$,
          {
            scope: "user",
            topic: "billing:changed",
            loopCommand$: reloadWorkerQueueDataFromRealtime$,
            options: {
              runOnForegroundCatchUp: false,
              runOnSubscribe: true,
            },
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

export const startSharedDatabaseWorkerDaemons$ = command(
  ({ get, set }): Promise<void> | null => {
    if (get(workerDaemonsStartedState$)) {
      return null;
    }
    const signal = get(rootSignal$);
    set(workerDaemonsStartedState$, true);
    return set(runSharedDatabaseWorkerDaemons$, signal);
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

type QueryMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "query" }
>;
type GetComputedMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-computed" }
>;
type ReloadComputedMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "reload-computed" }
>;

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

export const getComputedStoreMessage$ = command(
  async (
    { get, set },
    connectionId: ConnectionId,
    message: GetComputedMessage,
    signal: AbortSignal,
  ): Promise<ComputedValue<ComputedKey>> => {
    set(requireConnectionSignal$, connectionId, signal);
    const value =
      message.computedKey === "chat-thread-indicators"
        ? await get(workerChatThreadIndicators$)
        : message.computedKey === "computer-use-hosts"
          ? await get(computerUseHosts$)
          : await get(queueData$);
    signal.throwIfAborted();
    return value;
  },
);

export const reloadComputedStoreMessage$ = command(
  (
    { set },
    _connectionId: ConnectionId,
    message: ReloadComputedMessage,
  ): void => {
    set(reloadWorkerComputed$, message.computedKey);
    set(reloadComputedForConnections$, message.computedKey);
  },
);
