import type { Store } from "ccstate";
import { captureSentryLogError } from "../lib/sentry-config.ts";
import { logger } from "../signals/log.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseClientMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import {
  connectSharedDatabaseWorkerClient$,
  disconnectSharedDatabaseWorkerClient$,
  heartbeatSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  subscribeSharedDatabaseWorker$,
  unsubscribeSharedDatabaseWorker$,
} from "./worker-signals.ts";

type RequestMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly requestId: string }
>;

const L = logger("SharedDatabaseWorker");

function serializedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: Error.name, message: String(error) };
}

export class SharedDatabaseMessagePortServer {
  private readonly clientId = crypto.randomUUID();
  private readonly cancelledRequestIds = new Set<string>();
  private readonly requestTasks = new Map<string, Promise<void>>();
  private disconnected = false;

  constructor(
    private readonly store: Store,
    private readonly port: SharedDatabasePortLike,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.store.set(
      connectSharedDatabaseWorkerClient$,
      this.clientId,
      this.emit,
    );
    L.debug("client.connect", { clientId: this.clientId });
    port.addEventListener("message", this.handleMessage);
    port.start();
    signal.addEventListener(
      "abort",
      () => {
        this.disconnect("worker-abort");
      },
      { once: true },
    );
  }

  private readonly emit = (message: SharedDatabaseWorkerMessage): void => {
    if (!this.disconnected) {
      this.port.postMessage(message);
    }
  };

  private startRequest(
    message: RequestMessage,
    operation: (signal: AbortSignal) => Promise<unknown> | unknown,
  ): void {
    L.debug("request.start", {
      clientId: this.clientId,
      requestId: message.requestId,
      type: message.type,
    });
    const completion = (async (): Promise<void> => {
      const runOperation = async (): Promise<unknown> => {
        return await operation(this.signal);
      };
      const [result] = await Promise.allSettled([runOperation()]);
      this.requestTasks.delete(message.requestId);
      const cancelled = this.cancelledRequestIds.delete(message.requestId);
      if (cancelled || this.disconnected || this.signal.aborted || !result) {
        return;
      }
      if (result.status === "fulfilled") {
        L.debug("request.finish", {
          clientId: this.clientId,
          requestId: message.requestId,
          type: message.type,
        });
        this.emit({
          type: "result",
          requestId: message.requestId,
          value: result.value,
        });
        return;
      }
      const error = serializedError(result.reason);
      L.debug("request.error", {
        clientId: this.clientId,
        error,
        requestId: message.requestId,
        type: message.type,
      });
      this.emit({
        type: "error",
        requestId: message.requestId,
        error,
      });
    })();
    this.requestTasks.set(message.requestId, completion);
  }

  private disconnect(reason: string): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    L.debug("client.disconnect", { clientId: this.clientId, reason });
    this.port.removeEventListener("message", this.handleMessage);
    this.cancelledRequestIds.clear();
    this.requestTasks.clear();
    this.store.set(disconnectSharedDatabaseWorkerClient$, this.clientId);
    this.port.close();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const parsed = sharedDatabaseClientMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      this.disconnect("invalid-message");
      const error = new Error("Invalid shared database client message");
      const details = {
        clientId: this.clientId,
        issueCount: parsed.error.issues.length,
      };
      L.debug("protocol.error", { ...details, error });
      captureSentryLogError("SharedDatabaseWorker", [error, details]);
      return;
    }
    const message = parsed.data;
    if (message.type === "cancel") {
      L.debug("request.cancel", {
        clientId: this.clientId,
        requestId: message.requestId,
      });
      if (this.requestTasks.has(message.requestId)) {
        this.cancelledRequestIds.add(message.requestId);
      }
      return;
    }
    if (message.type === "disconnect") {
      this.disconnect("client-request");
      return;
    }
    if (message.type === "unsubscribe") {
      L.debug("subscription.remove", {
        clientId: this.clientId,
        subscriptionId: message.subscriptionId,
      });
      this.store.set(
        unsubscribeSharedDatabaseWorker$,
        this.clientId,
        message.subscriptionId,
      );
      return;
    }
    if (message.type === "heartbeat") {
      this.startRequest(message, (requestSignal) => {
        return this.store.set(
          heartbeatSharedDatabaseWorker$,
          this.clientId,
          {
            identity: message.identity,
            apiBaseUrl: message.apiBaseUrl,
            emit: this.emit,
            ...(message.vercelProtectionBypass
              ? {
                  vercelProtectionBypass: message.vercelProtectionBypass,
                }
              : {}),
          },
          requestSignal,
        );
      });
      return;
    }
    if (message.type === "subscribe") {
      this.startRequest(message, () => {
        this.store.set(
          subscribeSharedDatabaseWorker$,
          this.clientId,
          message.subscriptionId,
          message.dataKey,
        );
      });
      return;
    }
    this.startRequest(message, (requestSignal) => {
      return this.store.set(
        querySharedDatabaseWorker$,
        this.clientId,
        message.query,
        requestSignal,
      );
    });
  };
}
