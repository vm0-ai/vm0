import { command, type Store } from "ccstate";

import {
  setSharedDatabaseBridgeHostForTest$,
  type SharedDatabaseBridgeHost,
} from "../signals/shared-database-browser.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabaseSubscriptionCallback,
} from "./bridge.ts";
import {
  parseSharedDatabaseQueryResult,
  type ChatThreadIndicators,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import { MessagePortSharedDatabaseBridge } from "./message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "./message-port-server.ts";
import type {
  SharedDatabaseHeartbeatResult,
  SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import type { TabId } from "./worker-context.ts";
import {
  bootstrapSharedDatabaseWorker$,
  connectSharedDatabaseWorkerClient$,
  heartbeatSharedDatabaseWorker$,
  initializeCredentialStore$,
  querySharedDatabaseWorker$,
  readWorkerChatThreadIndicators$,
  subscribeSharedDatabaseWorker$,
  unsubscribeSharedDatabaseWorker$,
} from "./worker-signals.ts";
import { reloadChatIndicators$ } from "../signals/chat-thread-list-reload.ts";

/**
 * Ordinary page stories keep the production worker signals and computed
 * values but skip transport and realtime startup. SharedWorker user stories
 * opt into the complete MessagePort host explicitly.
 */
export type SharedWorkerTestTransport = "direct" | "message-port";

interface SetupSharedWorkerTestBootstrap {
  readonly afterHeartbeat?: () => Promise<void>;
  readonly identity: Pick<SharedDatabaseIdentity, "orgId" | "userId"> | null;
  readonly transport: SharedWorkerTestTransport;
  readonly workerStore: Store;
}

type DirectWorkerEvent = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "append"
      | "authentication-required"
      | "indicators-invalidated"
      | "invalidate"
      | "reload-required"
      | "status";
  }
>;

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

class DirectSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly clientId = crypto.randomUUID();
  private readonly subscriptions = new Map<
    string,
    {
      readonly callback: SharedDatabaseSubscriptionCallback;
      readonly dataKey: SharedDatabaseDataKey;
    }
  >();

  constructor(
    private readonly workerStore: Store,
    private readonly identity: Pick<SharedDatabaseIdentity, "orgId" | "userId">,
    private readonly apiBaseUrl: string,
    private readonly events: SharedDatabaseBridgeEvents,
    private readonly workerSignal: AbortSignal,
  ) {
    workerStore.set(
      connectSharedDatabaseWorkerClient$,
      this.clientId,
      this.emit,
    );
  }

  private readonly emit = (event: DirectWorkerEvent): void => {
    if (event.type === "append" || event.type === "invalidate") {
      this.subscriptions.get(event.subscriptionId)?.callback(event.type);
      return;
    }
    if (event.type === "authentication-required") {
      this.events.authenticationRequired();
      return;
    }
    if (event.type === "indicators-invalidated") {
      this.events.indicatorsInvalidated();
      return;
    }
    if (event.type === "reload-required") {
      this.events.reloadRequired();
      return;
    }
    this.events.statusChanged(event.status);
  };

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.workerStore.set(
      initializeCredentialStore$,
      {
        identity: { ...this.identity, token: heartbeat.token },
        apiBaseUrl: this.apiBaseUrl,
        ...(heartbeat.vercelProtectionBypass
          ? { vercelProtectionBypass: heartbeat.vercelProtectionBypass }
          : {}),
        onForceUpgrade: this.events.reloadRequired,
      },
      this.workerSignal,
    );
    const result = await waitForWorkerOperation(
      this.workerStore.set(
        heartbeatSharedDatabaseWorker$,
        this.clientId,
        {
          identity: { ...this.identity, token: heartbeat.token },
          apiBaseUrl: this.apiBaseUrl,
          emit: this.emit,
          ...(heartbeat.vercelProtectionBypass
            ? { vercelProtectionBypass: heartbeat.vercelProtectionBypass }
            : {}),
        },
        this.workerSignal,
      ),
      signal,
    );
    if (result.clientReconnected) {
      for (const [subscriptionId, subscription] of this.subscriptions) {
        this.workerStore.set(
          subscribeSharedDatabaseWorker$,
          this.clientId,
          subscriptionId,
          subscription.dataKey,
        );
      }
    }
    return result;
  }

  async indicators(signal: AbortSignal): Promise<ChatThreadIndicators> {
    return await waitForWorkerOperation(
      this.workerStore.set(readWorkerChatThreadIndicators$, this.workerSignal),
      signal,
    );
  }

  reloadIndicators(): void {
    this.workerStore.set(reloadChatIndicators$);
    this.events.indicatorsInvalidated();
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const operation = this.workerStore.set(
      querySharedDatabaseWorker$,
      this.clientId,
      query,
      this.workerSignal,
    );
    const result = await waitForWorkerOperation(operation, signal);
    const cloned: unknown = structuredClone(result);
    return parseSharedDatabaseQueryResult(query.dataKey, cloned);
  }

  on(
    dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const subscriptionId = crypto.randomUUID();
    this.subscriptions.set(subscriptionId, { callback, dataKey });
    this.workerStore.set(
      subscribeSharedDatabaseWorker$,
      this.clientId,
      subscriptionId,
      dataKey,
    );
    signal.addEventListener(
      "abort",
      () => {
        this.subscriptions.delete(subscriptionId);
        this.workerStore.set(
          unsubscribeSharedDatabaseWorker$,
          this.clientId,
          subscriptionId,
        );
      },
      { once: true },
    );
    return Promise.resolve();
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

  indicators(signal: AbortSignal): Promise<ChatThreadIndicators> {
    return this.bridge.indicators(signal);
  }

  reloadIndicators(): void {
    this.bridge.reloadIndicators();
  }

  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return this.bridge.query(query, signal);
  }

  on(
    dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void> {
    return this.bridge.on(dataKey, callback, signal);
  }
}

export const setupSharedWorkerTestBootstrap$ = command(
  (
    { set },
    options: SetupSharedWorkerTestBootstrap,
    signal: AbortSignal,
  ): void => {
    const directIdentity = options.identity;
    const maps = {
      credentialStores: new Map<string, Store>(),
      credentialAbortControllers: new Map<string, AbortController>(),
      tabCredentialIds: new Map<TabId, string>(),
      tabHeartbeatAts: new Map<TabId, number>(),
    };
    const host: SharedDatabaseBridgeHost = {
      createBridge: (apiBaseUrl, events) => {
        let bridge: SharedDatabaseBridge;
        if (options.transport === "message-port") {
          const channel = new MessageChannel();
          new SharedDatabaseMessagePortServer(channel.port1, signal, maps);
          bridge = new MessagePortSharedDatabaseBridge(
            channel.port2,
            apiBaseUrl,
            events,
          );
        } else {
          if (!directIdentity) {
            throw new Error("Authenticated test identity is required");
          }
          options.workerStore.set(bootstrapSharedDatabaseWorker$, signal);
          bridge = new DirectSharedDatabaseBridge(
            options.workerStore,
            directIdentity,
            apiBaseUrl,
            events,
            signal,
          );
        }
        return new TestSharedDatabaseBridge(bridge, options.afterHeartbeat);
      },
    };
    set(setSharedDatabaseBridgeHostForTest$, host);
  },
);
