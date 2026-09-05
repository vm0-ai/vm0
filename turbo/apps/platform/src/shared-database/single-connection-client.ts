import { observeClientOperation } from "../lib/client-telemetry.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  settle,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "./bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseWorkerUnavailableReason,
} from "./protocol.ts";

interface SingleConnectionSharedDatabaseBridgeOptions {
  readonly createBridge: (
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
  ) => SharedDatabaseBridge;
  readonly events: SharedDatabaseBridgeEvents;
}

export class SingleConnectionSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly connectionEvents: SharedDatabaseBridgeEvents;
  private bridge: SharedDatabaseBridge | null = null;
  private connectionController: AbortController | null = null;
  private ownerSignal: AbortSignal | null = null;
  private preparation: Promise<void> | null = null;
  private workerUnavailable = false;

  constructor(
    private readonly options: SingleConnectionSharedDatabaseBridgeOptions,
  ) {
    this.connectionEvents = {
      ...options.events,
      workerUnavailable: (reason) => {
        this.reportWorkerUnavailable(reason);
      },
    };
  }

  prepare(signal: AbortSignal): Promise<void> {
    this.bindOwner(signal);
    if (this.bridge) {
      return Promise.resolve();
    }
    if (this.preparation) {
      return this.preparation;
    }
    if (this.workerUnavailable) {
      return this.waitForReload(signal);
    }
    const preparation = this.prepareTransport(signal);
    this.preparation = preparation;
    return preparation;
  }

  async registerTab(signal: AbortSignal): Promise<void> {
    await this.prepare(signal);
    const bridge = this.requireRegistered(this.bridge);
    await bridge.registerTab(
      this.requireRegistered(this.connectionController).signal,
    );
    signal.throwIfAborted();
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const bridge = this.requireRegistered(this.bridge);
    return await observeClientOperation(
      {
        event_name: "shared_database.query",
        // Dataset kind and consistency are the complete low-cardinality query
        // shape; cursor and entity identifiers are intentionally omitted.
        template: `${query.dataKey.kind}.${query.consistency}`,
      },
      async () => {
        return await this.runWithReload(() => {
          return bridge.query(query, signal);
        }, signal);
      },
    );
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const bridge = this.requireRegistered(this.bridge);
    return await this.runWithReload(() => {
      return bridge.getComputed(computedKey);
    }, this.requireRegistered(this.ownerSignal));
  }

  private bindOwner(signal: AbortSignal): void {
    if (this.ownerSignal === signal) {
      return;
    }
    if (this.ownerSignal !== null) {
      throw new Error("Shared database bridge already has a lifecycle owner");
    }
    signal.throwIfAborted();
    this.ownerSignal = signal;
  }

  private async prepareTransport(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const controller = createChildAbortController(
      this.requireRegistered(this.ownerSignal),
    );
    this.options.events.statusChanged("connecting");
    const created = await settle(
      this.constructBridge(controller.signal),
      signal,
    );
    if (!created.ok) {
      controller.abort(created.error);
      return await this.requestReload(signal);
    }
    this.connectionController = controller;
    this.bridge = created.value;
  }

  private async constructBridge(
    signal: AbortSignal,
  ): Promise<SharedDatabaseBridge> {
    return await this.options.createBridge(this.connectionEvents, signal);
  }

  private async runWithReload<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.workerUnavailable) {
      return await this.waitForReload(signal);
    }
    const work = (async (): Promise<T> => {
      return await operation();
    })();
    const result = await settle(work, signal);
    if (this.workerUnavailable) {
      return await this.waitForReload(signal);
    }
    if (result.ok) {
      return result.value;
    }
    if (
      result.error instanceof Error &&
      result.error.name === SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME
    ) {
      return await this.requestReload(signal);
    }
    throw result.error;
  }

  private requestReload(signal: AbortSignal): Promise<never> {
    this.reportWorkerUnavailable("worker-load-or-transport-failure");
    return this.waitForReload(signal);
  }

  private reportWorkerUnavailable(
    reason: SharedDatabaseWorkerUnavailableReason,
  ): void {
    if (!this.workerUnavailable) {
      this.workerUnavailable = true;
      this.options.events.workerUnavailable(reason);
    }
  }

  private waitForReload(signal: AbortSignal): Promise<never> {
    return createDeferredPromise<never>(signal).promise;
  }

  private requireRegistered<T>(value: T | null): T {
    if (!value) {
      throw new Error("Shared database tab registration is required first");
    }
    return value;
  }
}
