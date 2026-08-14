import type { Store } from "ccstate";
import {
  parseSharedDatabaseQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { SharedDatabaseBridge } from "./bridge.ts";
import type { SharedDatabaseWorkerMessage } from "./protocol.ts";
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

type DirectWorkerEvent = Extract<
  SharedDatabaseWorkerMessage,
  { readonly type: "append" | "reload-required" | "status" }
>;

class DirectSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly clientId = crypto.randomUUID();
  private readonly callbacks = new Map<string, () => void>();
  private ownerSignal: AbortSignal | null = null;

  constructor(
    private readonly store: Store,
    private readonly apiBaseUrl: string,
  ) {
    store.set(
      connectSharedDatabaseWorkerClient$,
      this.clientId,
      (event: DirectWorkerEvent) => {
        if (event.type === "append") {
          this.callbacks.get(event.subscriptionId)?.();
          return;
        }
        if (event.type === "reload-required") {
          location.reload();
          return;
        }
        store.set(setSharedDatabaseConnectionStatus$, event.status);
      },
    );
  }

  async heartbeat(
    identity: SharedDatabaseIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    this.bindOwner(signal);
    await this.store.set(
      heartbeatSharedDatabaseWorker$,
      this.clientId,
      identity,
      this.apiBaseUrl,
      signal,
    );
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const result = await this.store.set(
      querySharedDatabaseWorker$,
      this.clientId,
      query,
      signal,
    );
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
    this.callbacks.set(subscriptionId, callback);
    this.store.set(
      subscribeSharedDatabaseWorker$,
      this.clientId,
      subscriptionId,
      dataKey,
    );
    signal.addEventListener(
      "abort",
      () => {
        this.callbacks.delete(subscriptionId);
        this.store.set(
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
        this.callbacks.clear();
        this.store.set(disconnectSharedDatabaseWorkerClient$, this.clientId);
      },
      { once: true },
    );
  }
}

export class SharedWorkerTestBootstrap {
  constructor(
    private readonly store: Store,
    signal: AbortSignal,
  ) {
    this.store.set(bootstrapSharedDatabaseWorker$, signal);
    const bridge = new DirectSharedDatabaseBridge(
      this.store,
      resolveApiBaseForTarget("api"),
    );
    this.store.set(installSharedDatabaseBridge$, bridge);
  }
}
