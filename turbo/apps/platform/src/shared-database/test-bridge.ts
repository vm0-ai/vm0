import type { Store } from "ccstate";
import {
  parseSharedDatabaseQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
} from "./bridge.ts";
import type {
  SharedDatabaseHeartbeatResult,
  SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import {
  bootstrapSharedDatabaseWorker$,
  connectSharedDatabaseWorkerClient$,
  disconnectSharedDatabaseWorkerClient$,
  heartbeatSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  subscribeSharedDatabaseWorker$,
  unsubscribeSharedDatabaseWorker$,
} from "./worker-signals.ts";
import {
  installSharedDatabaseBridge$,
  setSharedDatabaseConnectionStatus$,
} from "../signals/shared-database.ts";
import { resolveApiBaseForTarget } from "../signals/api-base.ts";
import { createDeferredPromise } from "../signals/utils.ts";

type DirectWorkerEvent = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "append"
      | "authentication-required"
      | "reload-required"
      | "status";
  }
>;

async function waitForWorkerOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return await Promise.race([operation, aborted.promise]);
}

class DirectSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly clientId = crypto.randomUUID();
  private readonly subscriptions = new Map<
    string,
    { readonly callback: () => void; readonly dataKey: SharedDatabaseDataKey }
  >();
  private ownerSignal: AbortSignal | null = null;

  constructor(
    private readonly platformStore: Store,
    private readonly workerStore: Store,
    private readonly apiBaseUrl: string,
    private readonly workerSignal: AbortSignal,
    private readonly afterWorkerHeartbeat?: () => Promise<void>,
  ) {
    workerStore.set(
      connectSharedDatabaseWorkerClient$,
      this.clientId,
      this.emit,
    );
  }

  private readonly emit = (event: DirectWorkerEvent): void => {
    if (event.type === "append") {
      this.subscriptions.get(event.subscriptionId)?.callback();
      return;
    }
    if (event.type === "reload-required") {
      location.reload();
      return;
    }
    if (event.type === "authentication-required") {
      return;
    }
    this.platformStore.set(setSharedDatabaseConnectionStatus$, event.status);
  };

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.bindOwner(signal);
    const result = await this.workerStore.set(
      heartbeatSharedDatabaseWorker$,
      this.clientId,
      { ...heartbeat, apiBaseUrl: this.apiBaseUrl, emit: this.emit },
      this.workerSignal,
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
    await this.afterWorkerHeartbeat?.();
    return result;
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    signal.throwIfAborted();
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
    callback: () => void,
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

  private bindOwner(signal: AbortSignal): void {
    if (this.ownerSignal === signal) {
      return;
    }
    if (this.ownerSignal !== null) {
      throw new Error("Shared database test bridge already has an owner");
    }
    signal.throwIfAborted();
    this.ownerSignal = signal;
    signal.addEventListener(
      "abort",
      () => {
        this.subscriptions.clear();
        this.workerStore.set(
          disconnectSharedDatabaseWorkerClient$,
          this.clientId,
        );
      },
      { once: true },
    );
  }
}

export class SharedWorkerTestBootstrap {
  constructor(
    private readonly platformStore: Store,
    private readonly workerStore: Store,
    signal: AbortSignal,
    afterWorkerHeartbeat?: () => Promise<void>,
  ) {
    this.workerStore.set(bootstrapSharedDatabaseWorker$, signal);
    const bridge = new DirectSharedDatabaseBridge(
      this.platformStore,
      this.workerStore,
      resolveApiBaseForTarget("api"),
      signal,
      afterWorkerHeartbeat,
    );
    this.platformStore.set(installSharedDatabaseBridge$, bridge);
  }
}
