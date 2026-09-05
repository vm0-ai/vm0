import type { InboundMessage } from "ably";
import { command, computed, state, type Command } from "ccstate";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { delay } from "signal-timers";

import { resolvePlatformEnvironment } from "../lib/platform-host.ts";
import { CONNECTION_DIAGNOSTICS_PARAM } from "../lib/connection-diagnostics-param.ts";
import { VERCEL_PROTECTION_BYPASS_NAME } from "../lib/preview-bypass-name.ts";
import { now } from "../lib/time.ts";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "../signals/api-client.ts";
import { setApiClientRuntime$ } from "../signals/api-client-runtime.ts";
import { initializeAppVersion$ } from "../signals/app-version.ts";
import { setAuthenticatedIdentity$ } from "../signals/auth-context.ts";
import {
  connectionDiagnostics$,
  setupConnectionDiagnostics$,
  writeConnectionDiagnostic$,
} from "../signals/connection-diagnostics.ts";
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
import {
  createDeferredPromise,
  onRejection,
  settle,
  withCleanup,
} from "../signals/utils.ts";
import {
  chatThreadIndicators$,
  reloadChatThreadIndicators$,
} from "../signals/chat-page/chat-thread-indicators.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import type { SharedDatabaseTokenProvider } from "./bridge.ts";
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
  reportWorkerUnavailableForConnections$,
  requireConnectionSignal$,
  updateRealtimeStatusForConnections$,
  type ConnectionId,
} from "./worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "./worker-runtime.ts";

const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);
const workerDaemonsStartedState$ = state(false);
interface BootstrapSharedDatabaseWorkerOptions {
  readonly appVersion: string;
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly getToken: SharedDatabaseTokenProvider;
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

const CHAT_EVENT_CATCH_UP_THROTTLE_MS = 1000;
const RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT = 100;

const batchChatEventCatchUpEnabled$ = computed(
  async (get): Promise<boolean> => {
    const signal = get(rootSignal$);
    signal.throwIfAborted();
    const client = get(apiClient$)(featureSwitchesContract);
    const response = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    return (
      response.body.effectiveSwitches[FeatureSwitchKey.BatchChatEventCatchUp] ??
      false
    );
  },
);

const catchUpLegacyChatEvents$ = command(
  async (
    { get },
    indicators: ChatThreadIndicators,
    signal: AbortSignal,
  ): Promise<void> => {
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
  },
);

const executeCatchUpChatEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const runtime = requireRuntime(get(workerRuntimeState$));
    const [indicators, threadEvents] = await Promise.all([
      get(chatThreadIndicators$),
      runtime.query(
        {
          dataKey: { kind: "chat-thread-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const recentThreadIds = replayChatThreadEvents(
      threadEvents.snapshot?.chatThreads ?? [],
      threadEvents.events,
    )
      .sort((left, right) => {
        const sortAt = right.sortAt.localeCompare(left.sortAt);
        return sortAt === 0 ? right.id.localeCompare(left.id) : sortAt;
      })
      .slice(0, RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT)
      .map((thread) => {
        return thread.id;
      });
    const threadIds = [
      ...new Set([...Object.keys(indicators.threads), ...recentThreadIds]),
    ];
    const updatedThreadIds = await runtime.catchUpChatEvents(threadIds, signal);
    signal.throwIfAborted();
    for (const threadId of updatedThreadIds) {
      set(broadcastSharedDatabaseWorkerMessage$, {
        type: "invalidate",
        dataKey: { kind: "chat-event", threadId },
      });
    }
  },
);

type CatchUpChatEventCompletion = ReturnType<
  typeof createDeferredPromise<void>
>;

/** Keep catch-up scheduling state private to one Worker lifecycle. */
function createCatchUpChatEventThrottle(): Command<
  Promise<void>,
  [AbortSignal]
> {
  const lastStartedAt$ = state<number | null>(null);
  const active$ = state<CatchUpChatEventCompletion | null>(null);
  const trailing$ = state<CatchUpChatEventCompletion | null>(null);

  const executeScheduledCatchUp$ = command(
    async (
      { get, set },
      completion: CatchUpChatEventCompletion,
      previous: Promise<void> | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (previous) {
        await settle(previous, signal);
      }
      const lastStartedAt = get(lastStartedAt$);
      const remaining =
        lastStartedAt === null
          ? 0
          : Math.max(
              0,
              lastStartedAt + CHAT_EVENT_CATCH_UP_THROTTLE_MS - now(),
            );
      if (remaining > 0) {
        await delay(remaining, { signal });
      }
      signal.throwIfAborted();

      if (get(trailing$) === completion) {
        set(trailing$, null);
      }
      set(active$, completion);
      set(lastStartedAt$, now());
      await set(executeCatchUpChatEvent$, signal);
    },
  );

  const runScheduledCatchUp$ = command(
    async (
      { get, set },
      completion: CatchUpChatEventCompletion,
      previous: Promise<void> | null,
      signal: AbortSignal,
    ): Promise<void> => {
      await onRejection(
        withCleanup(
          set(executeScheduledCatchUp$, completion, previous, signal),
          () => {
            if (get(active$) === completion) {
              set(active$, null);
            }
            if (get(trailing$) === completion) {
              set(trailing$, null);
            }
          },
        ),
        (error) => {
          if (!completion.settled()) {
            completion.reject(error);
          }
        },
      );
      signal.throwIfAborted();
      completion.resolve(undefined);
    },
  );

  return command(({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const trailing = get(trailing$);
    if (trailing) {
      return trailing.promise;
    }

    const active = get(active$);
    const lastStartedAt = get(lastStartedAt$);
    const leading =
      active === null &&
      (lastStartedAt === null ||
        now() - lastStartedAt >= CHAT_EVENT_CATCH_UP_THROTTLE_MS);
    const completion = createDeferredPromise<void>(signal);
    // Publish ownership before starting work: a trailing call may have no
    // remaining delay by the time it starts executing.
    set(leading ? active$ : trailing$, completion);
    return set(
      runScheduledCatchUp$,
      completion,
      active?.promise ?? null,
      signal,
    );
  });
}

const catchUpChatEventThrottle$ = computed((get) => {
  get(rootSignal$).throwIfAborted();
  return createCatchUpChatEventThrottle();
});

/** Globally serialize ChatEvent catch-up with leading and trailing throttle. */
const catchUpChatEvent$ = command(({ get, set }): Promise<void> => {
  return set(get(catchUpChatEventThrottle$), get(rootSignal$));
});

interface WorkerChatThreadIndicatorsCache {
  source: Promise<ChatThreadIndicators> | null;
  result: Promise<ChatThreadIndicators> | null;
}

const workerChatThreadIndicatorsCache$ = computed(
  (get): WorkerChatThreadIndicatorsCache => {
    get(rootSignal$).throwIfAborted();
    return { source: null, result: null };
  },
);

const loadWorkerChatThreadIndicators$ = command(
  async (
    { get, set },
    source: Promise<ChatThreadIndicators>,
    signal: AbortSignal,
  ): Promise<ChatThreadIndicators> => {
    const [indicators, batchCatchUpEnabled] = await Promise.all([
      source,
      get(batchChatEventCatchUpEnabled$),
    ]);
    signal.throwIfAborted();
    if (batchCatchUpEnabled) {
      await set(catchUpChatEvent$);
    } else {
      await set(catchUpLegacyChatEvents$, indicators, signal);
    }
    signal.throwIfAborted();
    return indicators;
  },
);

const readWorkerChatThreadIndicators$ = command(
  ({ get, set }): Promise<ChatThreadIndicators> => {
    const source = get(chatThreadIndicators$);
    const cache = get(workerChatThreadIndicatorsCache$);
    if (cache.source === source && cache.result) {
      return cache.result;
    }
    const result = set(
      loadWorkerChatThreadIndicators$,
      source,
      get(rootSignal$),
    );
    cache.source = source;
    cache.result = result;
    return result;
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
      getToken: options.getToken,
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

function resolveWorkerIdentity(): SharedDatabaseIdentity {
  const params = new URL(location.href).searchParams;
  return sharedDatabaseIdentitySchema.parse({
    userId: params.get("userId"),
    orgId: params.get("orgId"),
  });
}

export const bootstrapWorker$ = command(
  (
    { set },
    getToken: SharedDatabaseTokenProvider,
    signal: AbortSignal,
  ): void => {
    const params = new URL(location.href).searchParams;
    const apiBaseUrl = derivePlatformServiceOrigin(location.origin, "api");
    const vercelProtectionBypass = params.get(VERCEL_PROTECTION_BYPASS_NAME);
    set(setupConnectionDiagnostics$, signal);
    // The tab bakes the capture decision into the Worker URL, so a Worker
    // started for a debugging tab records from its very first event.
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: params.has(CONNECTION_DIAGNOSTICS_PARAM),
    });
    const oauthApiBaseUrl =
      resolvePlatformEnvironment() === "production"
        ? derivePlatformServiceOrigin(location.origin, "www")
        : apiBaseUrl;
    set(
      initializeSharedDatabaseWorker$,
      {
        appVersion: __OKOU_APP_VERSION__,
        identity: resolveWorkerIdentity(),
        apiBaseUrl,
        getToken,
        oauthApiBaseUrl,
        onForceUpgrade: () => {
          set(reportWorkerUnavailableForConnections$, "force-upgrade-required");
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
    switch (computedKey) {
      case "chat-thread-indicators": {
        set(reloadChatThreadIndicators$);
        return;
      }
      case "computer-use-hosts": {
        set(reloadComputerUseHosts$);
        return;
      }
      case "connection-diagnostics": {
        // Diagnostics derive from Worker Store state, so there is no fetch to
        // repeat: the next read already observes every recorded event.
        return;
      }
      case "queue-data": {
        set(reloadQueueData$);
        return;
      }
    }
  },
);

/** Recompute one Worker computed and tell every tab to re-read it. */
export const refreshWorkerComputed$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    set(reloadWorkerComputed$, computedKey);
    set(reloadComputedForConnections$, computedKey);
  },
);

const refreshWorkerChatIndicators$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "chat-thread-indicators");
    await set(readWorkerChatThreadIndicators$);
    signal.throwIfAborted();
  },
);

const reloadWorkerChatIndicatorsFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    return false;
  },
);

const reloadWorkerChatIndicatorsFromReadCursor$ = command(
  async ({ set }, payload: unknown, signal: AbortSignal): Promise<boolean> => {
    await set(refreshWorkerChatIndicators$, signal);
    set(forwardChatThreadReadCursorUpdated$, payload);
    set(reloadComputedForConnections$, "chat-thread-indicators");
    return false;
  },
);

const reloadWorkerComputerUseHostsFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadWorkerComputed$, "computer-use-hosts");
    set(reloadComputedForConnections$, "computer-use-hosts");
    return false;
  },
);

const reloadWorkerQueueDataFromRealtime$ = command(
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
    if (message.computedKey === "connection-diagnostics") {
      return get(connectionDiagnostics$);
    }
    if (message.computedKey === "indexeddb-diagnostics") {
      const diagnostics = await requireRuntime(
        get(workerRuntimeState$),
      ).getIndexedDbDiagnostics(signal);
      signal.throwIfAborted();
      return diagnostics;
    }
    if (message.computedKey === "indexeddb-snapshot-measurement") {
      return await requireRuntime(
        get(workerRuntimeState$),
      ).measureIndexedDbSnapshot(signal);
    }
    const value =
      message.computedKey === "chat-thread-indicators"
        ? await set(readWorkerChatThreadIndicators$)
        : message.computedKey === "computer-use-hosts"
          ? await get(computerUseHosts$)
          : await get(queueData$);
    signal.throwIfAborted();
    return value;
  },
);
