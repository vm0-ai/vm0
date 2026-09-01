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
} from "./bridge.ts";
import {
  redactSharedDatabaseClientMessageForLog,
  sharedDatabaseHeartbeatResultSchema,
  sharedDatabaseWorkerMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseHeartbeatResult,
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
  private ownerSignal: AbortSignal | null = null;
  private closed = false;
  private closeReason: unknown = new Error("Shared database bridge is closed");

  constructor(
    private readonly port: SharedDatabasePortLike,
    private readonly apiBaseUrl: string,
    private readonly events: SharedDatabaseBridgeEvents,
  ) {
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
      if (message.type === "reload-required") {
        this.events.reloadRequired();
        return;
      }
      if (message.type === "authentication-required") {
        this.events.authenticationRequired();
        return;
      }
      if (message.type === "indicators-invalidated") {
        this.events.indicatorsInvalidated(message.payload);
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

  reloadIndicators(): void {
    if (this.closed) {
      throw this.closeReason;
    }
    this.emit({ type: "reload-indicators" });
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
        this.close(signal.reason, false);
      },
      { once: true },
    );
  }

  private request(
    message: Extract<
      SharedDatabaseClientMessage,
      {
        readonly type: "heartbeat" | "query" | "get-indicators";
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
    this.emit(message);
    return deferred.promise;
  }

  private emit(message: SharedDatabaseClientMessage): void {
    L.debug(
      "send message to worker",
      redactSharedDatabaseClientMessageForLog(message),
    );
    this.port.postMessage(message);
  }

  private close(reason: unknown, reportDisconnected = true): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    this.emit({ type: "disconnect" });
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
