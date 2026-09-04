import {
  parseSharedDatabaseQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import {
  parseComputedValue,
  type ComputedKey,
  type ComputedValue,
} from "./computed-key.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
} from "./bridge.ts";
import {
  sharedDatabaseWorkerMessageSchema,
  type SharedDatabaseClientMessage,
} from "./protocol.ts";
import { logger } from "../signals/log.ts";
import { createDeferredPromise, onDomEventFn } from "../signals/utils.ts";

const L = logger("SharedWorkerBridge");

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class MessagePortSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly handleMessage: (event: MessageEvent<unknown>) => void;
  private readonly handleBridgeAbort: () => void;
  private registered = false;
  private closed = false;
  private closeReason: unknown = new Error("Shared database bridge is closed");

  constructor(
    private readonly port: SharedDatabasePortLike,
    private readonly events: SharedDatabaseBridgeEvents,
    private readonly bridgeSignal: AbortSignal,
  ) {
    bridgeSignal.throwIfAborted();
    this.handleBridgeAbort = () => {
      this.close(bridgeSignal.reason, false);
    };
    this.handleMessage = onDomEventFn(async (event) => {
      const message = sharedDatabaseWorkerMessageSchema.parse(event.data);
      L.debug("got message from worker", message);
      if (message.type === "invalidate") {
        await this.events.databaseInvalidated(message.dataKey);
        return;
      }
      if (message.type === "reconnect") {
        await this.events.databaseReconnected();
        return;
      }
      if (message.type === "worker-unavailable") {
        this.events.workerUnavailable(message.reason);
        return;
      }
      if (message.type === "reload-computed") {
        this.events.computedReloaded(message.computedKey);
        return;
      }
      if (message.type === "chat-thread-read-cursor-updated") {
        this.events.chatThreadReadCursorUpdated(message.payload);
        return;
      }
      if (message.type === "status") {
        this.events.statusChanged(message.status);
        return;
      }
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.requestId);
      if (message.type === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        pending.reject(error);
        return;
      }
      pending.resolve(message.value);
    });
    this.port.addEventListener("message", this.handleMessage);
    this.port.start();
    bridgeSignal.addEventListener("abort", this.handleBridgeAbort, {
      once: true,
    });
  }

  registerTab(signal: AbortSignal): Promise<void> {
    AbortSignal.any([signal, this.bridgeSignal]).throwIfAborted();
    this.registered = true;
    this.emit({ type: "register-tab" });
    return Promise.resolve();
  }

  fail(reason: unknown): void {
    this.close(reason, false);
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    this.requireRegistration();
    const value = await this.request({
      type: "get-computed",
      requestId: crypto.randomUUID(),
      computedKey,
    });
    return parseComputedValue(computedKey, value);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const value = await this.request(
      {
        type: "query",
        requestId: crypto.randomUUID(),
        query,
      },
      signal,
    );
    return parseSharedDatabaseQueryResult(query.dataKey, value);
  }

  private request(
    message: Extract<
      SharedDatabaseClientMessage,
      {
        readonly type: "query" | "get-computed";
      }
    >,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.bridgeSignal])
      : this.bridgeSignal;
    signal.throwIfAborted();
    if (this.closed) {
      throw this.closeReason;
    }
    const deferred = createDeferredPromise<unknown>(signal);
    const requestId = message.requestId;
    const abort = () => {
      this.pendingRequests.delete(requestId);
    };
    const finish = (callback: (value: unknown) => void) => {
      return (value: unknown) => {
        signal.removeEventListener("abort", abort);
        if (!deferred.settled()) {
          callback(value);
        }
      };
    };
    this.pendingRequests.set(requestId, {
      resolve: finish(deferred.resolve),
      reject: finish(deferred.reject),
    });
    signal.addEventListener("abort", abort, { once: true });
    this.emit(message);
    return deferred.promise;
  }

  private requireRegistration(): void {
    if (!this.registered) {
      throw new Error("Shared database tab registration is required first");
    }
  }

  private emit(message: SharedDatabaseClientMessage): void {
    L.debug("send message to worker", message);
    this.port.postMessage(message);
  }

  private close(reason: unknown, reportDisconnected = true): void {
    if (this.closed) {
      return;
    }
    this.port.postMessage({
      type: "disconnect",
    } satisfies SharedDatabaseClientMessage);
    this.closed = true;
    this.closeReason = reason;
    this.bridgeSignal.removeEventListener("abort", this.handleBridgeAbort);
    this.port.removeEventListener("message", this.handleMessage);
    this.port.close();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
    if (reportDisconnected) {
      this.events.statusChanged("disconnected");
    }
  }
}
