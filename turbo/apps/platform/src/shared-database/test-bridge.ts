import { command, type Store } from "ccstate";

import {
  subscribeChatDatabaseEvents,
  subscribeChatDatabaseRecovery,
  subscribeUserRealtimeEvents,
} from "../mocks/ably.ts";
import {
  resolveApiBaseForTarget,
  resolveOAuthApiBase,
} from "../signals/api-base.ts";
import type { ClerkTokenSource } from "../signals/clerk-token.ts";
import {
  setSharedDatabaseBridgeHostForTest$,
  type SharedDatabaseBridgeHost,
} from "../signals/shared-database-browser.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  onDomEventFn,
  Reason,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
} from "./bridge.ts";
import {
  parseComputedValue,
  type ComputedKey,
  type ComputedValue,
} from "./computed-key.ts";
import {
  parseSharedDatabaseQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import { MessagePortSharedDatabaseBridge } from "./message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "./message-port-server.ts";
import {
  forwardChatThreadReadCursorUpdated$,
  registerConnection$,
  reloadConnections$,
  type WorkerBroadcastMessage,
} from "./worker-context.ts";
import {
  getComputedStoreMessage$,
  handleSharedDatabaseRealtimeMessage$,
  initializeSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  recoverSharedDatabaseWorkerAfterRealtimeReconnect$,
  refreshWorkerComputed$,
  startSharedDatabaseWorkerDaemons$,
} from "./worker-signals.ts";

/**
 * Ordinary page stories keep the production worker signals and computed
 * values but use an in-process transport. SharedWorker transport stories opt
 * into the complete MessagePort host explicitly.
 */
export type SharedWorkerTestTransport = "direct" | "message-port";

interface SetupSharedWorkerTestBootstrap {
  readonly afterRegistration?: () => Promise<void>;
  readonly appVersion: string;
  readonly clerk: Promise<ClerkTokenSource>;
  readonly identity: SharedDatabaseIdentity | null;
  readonly transport: SharedWorkerTestTransport;
  readonly workerStore: Store;
}

interface DirectRealtimeMessage {
  readonly data: unknown;
  readonly name: string;
}

function waitForWorkerOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const waitController = createChildAbortController(signal);
  const aborted = createDeferredPromise<never>(waitController.signal);
  return withCleanup(Promise.race([operation, aborted.promise]), () => {
    waitController.abort(
      new DOMException("Worker operation completed", "AbortError"),
    );
  });
}

function directWorkerPort(
  emit: (message: WorkerBroadcastMessage) => void,
): SharedDatabasePortLike {
  return {
    postMessage: (value) => {
      emit(value as WorkerBroadcastMessage);
    },
    start: () => {},
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

class DirectSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly connectionId = crypto.randomUUID();
  private connectionSignal: AbortSignal | null = null;

  constructor(
    private readonly workerStore: Store,
    private readonly events: SharedDatabaseBridgeEvents,
    private readonly workerSignal: AbortSignal,
  ) {}

  private readonly emit = onDomEventFn(
    async (event: WorkerBroadcastMessage): Promise<void> => {
      if (event.type === "invalidate") {
        await this.events.databaseInvalidated(event.dataKey);
        return;
      }
      if (event.type === "reconnect") {
        await this.events.databaseReconnected();
        return;
      }
      if (event.type === "reload-computed") {
        this.events.computedReloaded(event.computedKey);
        return;
      }
      if (event.type === "chat-thread-read-cursor-updated") {
        this.events.chatThreadReadCursorUpdated(event.payload);
        return;
      }
      if (event.type === "reload-required") {
        this.events.reloadRequired();
        return;
      }
      this.events.statusChanged(event.status);
    },
  );

  handleRealtimeMessage(message: DirectRealtimeMessage): void {
    this.workerStore.set(
      handleSharedDatabaseRealtimeMessage$,
      message,
      this.workerSignal,
    );
    const computedKey: ComputedKey | null =
      message.name === "threadListChanged" ||
      message.name === "chatThreadReadCursorUpdated"
        ? "chat-thread-indicators"
        : message.name === "computerUseHostsChanged"
          ? "computer-use-hosts"
          : message.name === "billing:changed"
            ? "queue-data"
            : null;
    if (!computedKey) {
      return;
    }
    if (message.name === "chatThreadReadCursorUpdated") {
      this.workerStore.set(forwardChatThreadReadCursorUpdated$, message.data);
    }
    this.workerStore.set(refreshWorkerComputed$, computedKey);
  }

  handleRealtimeRecovery(): void {
    this.workerStore.set(
      recoverSharedDatabaseWorkerAfterRealtimeReconnect$,
      this.workerSignal,
    );
  }

  registerTab(signal: AbortSignal): Promise<void> {
    if (this.connectionSignal) {
      throw new Error("Shared database tab is already registered");
    }
    const connectionController = createChildAbortController(signal);
    const connectionSignal = connectionController.signal;
    this.connectionSignal = this.workerStore.set(
      registerConnection$,
      this.connectionId,
      connectionController,
      directWorkerPort(this.emit),
      connectionSignal,
    );
    return Promise.resolve();
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const signal = this.requireConnectionSignal();
    const value = await waitForWorkerOperation(
      this.workerStore.set(
        getComputedStoreMessage$,
        this.connectionId,
        {
          type: "get-computed",
          requestId: "direct-test-bridge",
          computedKey,
        },
        signal,
      ),
      signal,
    );
    const cloned: unknown = structuredClone(value);
    return parseComputedValue(computedKey, cloned);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const operation = this.workerStore.set(
      querySharedDatabaseWorker$,
      this.connectionId,
      query,
      this.requireConnectionSignal(),
    );
    const result = await waitForWorkerOperation(operation, signal);
    const cloned: unknown = structuredClone(result);
    return parseSharedDatabaseQueryResult(query.dataKey, cloned);
  }

  private requireConnectionSignal(): AbortSignal {
    if (!this.connectionSignal) {
      throw new Error("Shared database tab registration is required first");
    }
    return this.connectionSignal;
  }
}

class TestSharedDatabaseBridge implements SharedDatabaseBridge {
  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly afterRegistration?: () => Promise<void>,
  ) {}

  async registerTab(signal: AbortSignal): Promise<void> {
    await this.bridge.registerTab(signal);
    await this.afterRegistration?.();
  }

  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return this.bridge.getComputed(computedKey);
  }

  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return this.bridge.query(query, signal);
  }
}

export const setupSharedWorkerTestBootstrap$ = command(
  (
    { set },
    options: SetupSharedWorkerTestBootstrap,
    signal: AbortSignal,
  ): void => {
    if (options.identity) {
      options.workerStore.set(
        initializeSharedDatabaseWorker$,
        {
          appVersion: options.appVersion,
          identity: options.identity,
          apiBaseUrl: resolveApiBaseForTarget("api"),
          clerk: options.clerk,
          oauthApiBaseUrl: resolveOAuthApiBase(),
          onForceUpgrade: () => {
            options.workerStore.set(reloadConnections$);
          },
        },
        signal,
      );
      if (options.transport === "message-port") {
        const daemon = options.workerStore.set(
          startSharedDatabaseWorkerDaemons$,
        );
        if (daemon) {
          detach(daemon, Reason.Daemon, "test shared database Worker");
        }
      }
    }

    let directBridge: DirectSharedDatabaseBridge | null = null;
    let directRealtimeForwardingInstalled = false;
    const host: SharedDatabaseBridgeHost = {
      createBridge: (_identity, events, _connectionSignal) => {
        let bridge: SharedDatabaseBridge;
        if (options.transport === "message-port") {
          const channel = new MessageChannel();
          new SharedDatabaseMessagePortServer(
            options.workerStore,
            channel.port1,
            signal,
          );
          bridge = new MessagePortSharedDatabaseBridge(channel.port2, events);
        } else {
          if (!directRealtimeForwardingInstalled) {
            subscribeChatDatabaseEvents((message) => {
              directBridge?.handleRealtimeMessage(message);
            }, signal);
            subscribeUserRealtimeEvents((message) => {
              directBridge?.handleRealtimeMessage(message);
            }, signal);
            subscribeChatDatabaseRecovery(() => {
              directBridge?.handleRealtimeRecovery();
            }, signal);
            directRealtimeForwardingInstalled = true;
          }
          directBridge = new DirectSharedDatabaseBridge(
            options.workerStore,
            events,
            signal,
          );
          bridge = directBridge;
        }
        return new TestSharedDatabaseBridge(bridge, options.afterRegistration);
      },
    };
    set(setSharedDatabaseBridgeHostForTest$, host);
  },
);
