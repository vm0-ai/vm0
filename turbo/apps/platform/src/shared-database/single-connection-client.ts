import { delay } from "signal-timers";

import { observeClientOperation } from "../lib/client-telemetry.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  settle,
  withCleanup,
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

const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

interface SingleConnectionSharedDatabaseBridgeOptions {
  readonly createBridge: (
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
  ) => SharedDatabaseBridge;
  readonly events: SharedDatabaseBridgeEvents;
  readonly controlRequestTimeoutMs?: number;
}

class SharedDatabaseTransportTimeoutError extends Error {
  constructor() {
    super("Shared database worker transport timed out");
    this.name = "SharedDatabaseTransportTimeoutError";
  }
}

function requiresReload(error: unknown): boolean {
  return (
    error instanceof SharedDatabaseTransportTimeoutError ||
    (error instanceof Error &&
      error.name === SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME)
  );
}

async function withTransportTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const timeoutController = createChildAbortController(signal);
  const timeout = (async (): Promise<never> => {
    await delay(timeoutMs, { signal: timeoutController.signal });
    throw new SharedDatabaseTransportTimeoutError();
  })();
  return await withCleanup(Promise.race([work, timeout]), () => {
    timeoutController.abort(
      new DOMException("Transport request completed", "AbortError"),
    );
  });
}

export class SingleConnectionSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly controlRequestTimeoutMs: number;
  private readonly connectionEvents: SharedDatabaseBridgeEvents;
  private bridge: SharedDatabaseBridge | null = null;
  private connectionController: AbortController | null = null;
  private ownerSignal: AbortSignal | null = null;
  private preparation: Promise<void> | null = null;
  private workerUnavailable = false;

  constructor(
    private readonly options: SingleConnectionSharedDatabaseBridgeOptions,
  ) {
    this.controlRequestTimeoutMs =
      options.controlRequestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
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
    const bridge = this.requireBridge();
    await bridge.registerTab(this.requireConnectionController().signal);
    signal.throwIfAborted();
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const bridge = this.requireBridge();
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
    const bridge = this.requireBridge();
    return await this.runWithReload(() => {
      return bridge.getComputed(computedKey);
    }, this.requireOwnerSignal());
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
    const controller = createChildAbortController(this.requireOwnerSignal());
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
    const result = await settle(
      withTransportTimeout(
        work,
        this.controlRequestTimeoutMs,
        this.requireConnectionController().signal,
      ),
      signal,
    );
    if (this.workerUnavailable) {
      return await this.waitForReload(signal);
    }
    if (result.ok) {
      return result.value;
    }
    if (!requiresReload(result.error)) {
      throw result.error;
    }
    return await this.requestReload(signal);
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

  private requireBridge(): SharedDatabaseBridge {
    if (!this.bridge) {
      throw new Error("Shared database tab registration is required first");
    }
    return this.bridge;
  }

  private requireConnectionController(): AbortController {
    if (!this.connectionController) {
      throw new Error("Shared database tab registration is required first");
    }
    return this.connectionController;
  }

  private requireOwnerSignal(): AbortSignal {
    if (!this.ownerSignal) {
      throw new Error("Shared database tab registration is required first");
    }
    return this.ownerSignal;
  }
}
