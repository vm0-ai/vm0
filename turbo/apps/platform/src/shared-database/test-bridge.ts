import { command, type Store } from "ccstate";

import {
  subscribeChatDatabaseEvents,
  subscribeChatDatabaseRecovery,
  subscribeUserRealtimeEvents,
} from "../mocks/ably.ts";
import {
  setSharedDatabaseBridgeHostForTest$,
  type SharedDatabaseBridgeHost,
} from "../signals/shared-database-browser.ts";
import { initializeAppVersion$ } from "../signals/app-version.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  onDomEventFn,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
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
import type { SharedDatabaseHeartbeatResult } from "./protocol.ts";
import { SharedDatabaseWorkerContext } from "./worker-host-context.ts";
import {
  broadcastSharedDatabaseWorkerMessage$,
  forceRefreshWorkerToken$,
  forwardChatThreadReadCursorUpdated$,
  getWorkerToken$,
  registerConnection$,
  reloadConnections$,
  setWorkerToken$,
  type WorkerBroadcastMessage,
} from "./worker-context.ts";
import {
  handleSharedDatabaseRealtimeMessage$,
  heartbeatSharedDatabaseWorker$,
  getComputedStoreMessage$,
  initializeCredentialStore$,
  querySharedDatabaseWorker$,
  recoverCredentialStoreAfterRealtimeReconnect$,
  reloadComputedStoreMessage$,
} from "./worker-signals.ts";

/**
 * Ordinary page stories keep the production worker signals and computed
 * values but skip transport and realtime startup. SharedWorker user stories
 * opt into the complete MessagePort host explicitly.
 */
export type SharedWorkerTestTransport = "direct" | "message-port";

interface SetupSharedWorkerTestBootstrap {
  readonly appVersion: string;
  readonly afterHeartbeat?: () => Promise<void>;
  readonly identity: Pick<SharedDatabaseIdentity, "orgId" | "userId"> | null;
  readonly transport: SharedWorkerTestTransport;
  readonly workerStore: Store;
}

interface DirectWorkerState {
  credentialController: AbortController | null;
}

interface DirectSharedDatabaseBridgeOptions {
  readonly identity: Pick<SharedDatabaseIdentity, "orgId" | "userId"> | null;
  readonly apiBaseUrl: string;
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
  private connectionController: AbortController | null = null;
  private connectionSignal: AbortSignal | null = null;

  constructor(
    private readonly workerStore: Store,
    private readonly state: DirectWorkerState,
    private readonly options: DirectSharedDatabaseBridgeOptions,
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
      if (event.type === "authentication-required") {
        await this.events.authenticationRequired(event.recoveryId);
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
    this.workerStore.set(reloadComputedStoreMessage$, this.connectionId, {
      type: "reload-computed",
      computedKey,
    });
  }

  handleRealtimeRecovery(): void {
    this.workerStore.set(
      recoverCredentialStoreAfterRealtimeReconnect$,
      this.workerSignal,
    );
  }

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    if (!this.options.identity) {
      throw new Error("Authenticated test identity is required");
    }
    const identity = { ...this.options.identity, token: heartbeat.token };
    if (!this.state.credentialController) {
      const credentialController = createChildAbortController(
        this.workerSignal,
      );
      const credentialSignal = credentialController.signal;
      this.state.credentialController = credentialController;
      const broadcast = (message: WorkerBroadcastMessage): void => {
        this.workerStore.set(broadcastSharedDatabaseWorkerMessage$, message);
      };
      this.workerStore.set(
        initializeCredentialStore$,
        {
          controller: credentialController,
          authRecovery: {
            getToken: (signal) => {
              return this.workerStore.set(getWorkerToken$, signal);
            },
            forceRefreshToken: (signal) => {
              return this.workerStore.set(forceRefreshWorkerToken$, signal);
            },
          },
          broadcast,
        },
        {
          identity,
          apiBaseUrl: this.options.apiBaseUrl,
          vercelProtectionBypass: heartbeat.vercelProtectionBypass,
          onForceUpgrade: () => {
            this.workerStore.set(reloadConnections$);
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
    }
    if (!this.connectionController) {
      const connectionController = createChildAbortController(signal);
      const connectionControllerSignal = connectionController.signal;
      this.connectionController = connectionController;
      this.connectionSignal = this.workerStore.set(
        registerConnection$,
        this.connectionId,
        connectionController,
        directWorkerPort(this.emit),
        connectionControllerSignal,
      );
    }
    const connectionSignal = this.connectionSignal;
    if (!connectionSignal) {
      throw new Error(
        "Direct SharedWorker test connection was not initialized",
      );
    }
    return await waitForWorkerOperation(
      Promise.resolve(
        this.workerStore.set(
          heartbeatSharedDatabaseWorker$,
          this.connectionId,
          connectionSignal,
        ),
      ),
      signal,
    );
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

  reloadComputed(computedKey: ComputedKey): void {
    this.workerStore.set(reloadComputedStoreMessage$, this.connectionId, {
      type: "reload-computed",
      computedKey,
    });
  }

  setToken(
    recoveryId: string,
    token: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.workerStore.set(setWorkerToken$, this.connectionId, recoveryId, token);
    return Promise.resolve();
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
      throw new Error("Shared database heartbeat is required first");
    }
    return this.connectionSignal;
  }
}

class TestSharedDatabaseBridge implements SharedDatabaseBridge {
  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly afterHeartbeat?: () => Promise<void>,
  ) {}

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    const result = await this.bridge.heartbeat(heartbeat, signal);
    await this.afterHeartbeat?.();
    return result;
  }

  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return this.bridge.getComputed(computedKey);
  }

  reloadComputed(computedKey: ComputedKey): void {
    this.bridge.reloadComputed(computedKey);
  }

  setToken(
    recoveryId: string,
    token: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    return this.bridge.setToken(recoveryId, token, signal);
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
    options.workerStore.set(initializeAppVersion$, options.appVersion);
    const directIdentity = options.identity;
    const directState: DirectWorkerState = { credentialController: null };
    let directBridge: DirectSharedDatabaseBridge | null = null;
    let directRealtimeForwardingInstalled = false;
    const context = new SharedDatabaseWorkerContext(signal, options.appVersion);
    const host: SharedDatabaseBridgeHost = {
      createBridge: (apiBaseUrl, events, _connectionSignal) => {
        let bridge: SharedDatabaseBridge;
        if (options.transport === "message-port") {
          const channel = new MessageChannel();
          new SharedDatabaseMessagePortServer(context, channel.port1, signal);
          bridge = new MessagePortSharedDatabaseBridge(
            channel.port2,
            apiBaseUrl,
            events,
          );
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
            directState,
            { identity: directIdentity, apiBaseUrl },
            events,
            signal,
          );
          bridge = directBridge;
        }
        return new TestSharedDatabaseBridge(bridge, options.afterHeartbeat);
      },
    };
    set(setSharedDatabaseBridgeHostForTest$, host);
  },
);
