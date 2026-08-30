import {
  chatThreadIndicatorsSchema,
  parseSharedDatabaseQueryResult,
  type ChatThreadIndicators,
  type SharedDatabaseDataKey,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabasePortLike,
  SharedDatabaseSubscriptionCallback,
} from "./bridge.ts";
import {
  sharedDatabaseHeartbeatResultSchema,
  sharedDatabaseWorkerMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseHeartbeatResult,
} from "./protocol.ts";
import { createDeferredPromise, onRejection } from "../signals/utils.ts";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface Subscription {
  readonly dataKey: SharedDatabaseDataKey;
  readonly callback: SharedDatabaseSubscriptionCallback;
}

export class MessagePortSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly handleMessage: (event: MessageEvent<unknown>) => void;
  private ownerSignal: AbortSignal | null = null;
  private closed = false;
  private closeReason: unknown = new Error("Shared database bridge is closed");

  constructor(
    private readonly port: SharedDatabasePortLike,
    private readonly apiBaseUrl: string,
    private readonly events: SharedDatabaseBridgeEvents,
  ) {
    this.handleMessage = (event) => {
      const message = sharedDatabaseWorkerMessageSchema.parse(event.data);
      if (message.type === "append" || message.type === "invalidate") {
        const subscription = this.subscriptions.get(message.subscriptionId);
        if (subscription) {
          subscription.callback(message.type);
        }
        return;
      }
      if (message.type === "reload-required") {
        this.events.reloadRequired();
        return;
      }
      if (message.type === "authentication-required") {
        this.events.authenticationRequired();
        return;
      }
      if (message.type === "indicators-invalidated") {
        this.events.indicatorsInvalidated();
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
    };
    this.port.addEventListener("message", this.handleMessage);
    this.port.start();
  }

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.bindOwner(signal);
    const value = await this.request(
      {
        type: "heartbeat",
        requestId: crypto.randomUUID(),
        token: heartbeat.token,
        apiBaseUrl: this.apiBaseUrl,
        ...(heartbeat.vercelProtectionBypass
          ? { vercelProtectionBypass: heartbeat.vercelProtectionBypass }
          : {}),
      },
      signal,
    );
    return sharedDatabaseHeartbeatResultSchema.parse(value);
  }

  fail(reason: unknown): void {
    this.close(reason, false);
  }

  async indicators(signal: AbortSignal): Promise<ChatThreadIndicators> {
    const value = await this.request(
      {
        type: "get-indicators",
        requestId: crypto.randomUUID(),
      },
      signal,
    );
    return chatThreadIndicatorsSchema.parse(value);
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

  async on(
    dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const subscriptionId = crypto.randomUUID();
    this.subscriptions.set(subscriptionId, { dataKey, callback });
    const unsubscribe = () => {
      this.subscriptions.delete(subscriptionId);
      if (!this.closed) {
        this.port.postMessage({ type: "unsubscribe", subscriptionId });
      }
    };
    signal.addEventListener("abort", unsubscribe, { once: true });
    await onRejection(
      this.request(
        {
          type: "subscribe",
          requestId: crypto.randomUUID(),
          subscriptionId,
          dataKey,
        },
        signal,
      ),
      () => {
        signal.removeEventListener("abort", unsubscribe);
        unsubscribe();
      },
    );
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
    signal.addEventListener(
      "abort",
      () => {
        this.close(signal.reason);
      },
      { once: true },
    );
  }

  private request(
    message: Extract<
      SharedDatabaseClientMessage,
      {
        readonly type: "heartbeat" | "query" | "subscribe" | "get-indicators";
      }
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
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
    this.port.postMessage(message);
    return deferred.promise;
  }

  private close(reason: unknown, reportDisconnected = true): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    this.port.removeEventListener("message", this.handleMessage);
    this.port.close();
    this.subscriptions.clear();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
    if (reportDisconnected) {
      this.events.statusChanged("disconnected");
    }
  }
}
