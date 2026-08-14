import type { Store } from "ccstate";
import { createChildAbortController } from "../signals/utils.ts";
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

function serializedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: Error.name, message: String(error) };
}

function cancelRequest(controller: AbortController | undefined): void {
  controller?.abort(
    new DOMException("Shared database request cancelled", "AbortError"),
  );
}

export class SharedDatabaseMessagePortServer {
  constructor(
    private readonly store: Store,
    port: SharedDatabasePortLike,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const clientId = crypto.randomUUID();
    const requestControllers = new Map<string, AbortController>();
    const requestTasks = new Map<string, Promise<void>>();
    let disconnected = false;
    const emit = (message: SharedDatabaseWorkerMessage): void => {
      if (!disconnected) {
        port.postMessage(message);
      }
    };
    this.store.set(connectSharedDatabaseWorkerClient$, clientId, emit);
    const finishRequest = (requestId: string): void => {
      requestControllers.delete(requestId);
      requestTasks.delete(requestId);
    };
    const startRequest = (
      message: RequestMessage,
      operation: (signal: AbortSignal) => Promise<unknown> | unknown,
    ): void => {
      const controller = createChildAbortController(signal);
      requestControllers.set(message.requestId, controller);
      const completion = (async (): Promise<void> => {
        const runOperation = async (): Promise<unknown> => {
          return await operation(controller.signal);
        };
        const [result] = await Promise.allSettled([runOperation()]);
        finishRequest(message.requestId);
        if (controller.signal.aborted || !result) {
          return;
        }
        if (result.status === "fulfilled") {
          emit({
            type: "result",
            requestId: message.requestId,
            value: result.value,
          });
          return;
        }
        emit({
          type: "error",
          requestId: message.requestId,
          error: serializedError(result.reason),
        });
      })();
      requestTasks.set(message.requestId, completion);
    };

    const disconnect = (): void => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      port.removeEventListener("message", handleMessage);
      for (const controller of requestControllers.values()) {
        controller.abort(
          new DOMException("MessagePort disconnected", "AbortError"),
        );
      }
      requestControllers.clear();
      requestTasks.clear();
      this.store.set(disconnectSharedDatabaseWorkerClient$, clientId);
      port.close();
    };

    const handleMessage = (event: MessageEvent<unknown>): void => {
      const parsed = sharedDatabaseClientMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        disconnect();
        return;
      }
      const message = parsed.data;
      if (message.type === "cancel") {
        cancelRequest(requestControllers.get(message.requestId));
        return;
      }
      if (message.type === "disconnect") {
        disconnect();
        return;
      }
      if (message.type === "unsubscribe") {
        this.store.set(
          unsubscribeSharedDatabaseWorker$,
          clientId,
          message.subscriptionId,
        );
        return;
      }
      if (message.type === "heartbeat") {
        startRequest(message, (requestSignal) => {
          return this.store.set(
            heartbeatSharedDatabaseWorker$,
            clientId,
            message.identity,
            message.apiBaseUrl,
            requestSignal,
          );
        });
        return;
      }
      if (message.type === "subscribe") {
        startRequest(message, () => {
          this.store.set(
            subscribeSharedDatabaseWorker$,
            clientId,
            message.subscriptionId,
            message.dataKey,
          );
        });
        return;
      }
      startRequest(message, (requestSignal) => {
        return this.store.set(
          querySharedDatabaseWorker$,
          clientId,
          message.query,
          requestSignal,
        );
      });
    };

    port.addEventListener("message", handleMessage);
    port.start();
    signal.addEventListener("abort", disconnect, { once: true });
  }
}
