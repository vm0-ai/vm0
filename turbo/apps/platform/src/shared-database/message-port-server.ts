import type { Store } from "ccstate";

import { captureSentryLogError } from "../lib/sentry-config.ts";
import { logger } from "../signals/log.ts";
import {
  createChildAbortController,
  onDomEventFn,
  settle,
} from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseClientMessageSchema,
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseClientMessage,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import { registerConnection$ } from "./worker-context.ts";
import { setWorkerDevBrowserJwt$ } from "./worker-dev-browser.ts";
import {
  getComputedStoreMessage$,
  queryStoreMessage$,
  reloadComputedStoreMessage$,
} from "./worker-signals.ts";

type RequestMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly requestId: string }
>;
type RoutedMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-computed" | "query" | "reload-computed" }
>;

const L = logger("SharedDatabaseWorker");
const BridgeL = logger("SharedWorkerBridge");

function serializedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: Error.name, message: String(error) };
}

class SharedDatabaseClientNotConnectedError extends Error {
  constructor() {
    super("Shared database tab registration is required before query");
    this.name = SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME;
  }
}

export class SharedDatabaseMessagePortServer {
  private readonly connectionId = crypto.randomUUID();
  private readonly connectionController: AbortController;
  private readonly connectionSignal: AbortSignal;
  private registeredSignal: AbortSignal | null = null;
  private disconnected = false;

  constructor(
    private readonly store: Store,
    private readonly port: SharedDatabasePortLike,
    workerSignal: AbortSignal,
  ) {
    workerSignal.throwIfAborted();
    this.connectionController = createChildAbortController(workerSignal);
    this.connectionSignal = this.connectionController.signal;
    L.debug("connection.connect", { connectionId: this.connectionId });
    port.addEventListener("message", this.handleMessage);
    port.start();
    this.connectionSignal.addEventListener(
      "abort",
      this.handleConnectionAbort,
      { once: true },
    );
  }

  private readonly handleConnectionAbort = (): void => {
    this.disconnect("connection-abort");
  };

  private readonly handleRegisteredConnectionAbort = (): void => {
    this.disconnect("worker-abort");
  };

  private emit(message: SharedDatabaseWorkerMessage): void {
    if (!this.disconnected) {
      BridgeL.debug("send message to app", this.connectionId, message);
      this.port.postMessage(message);
    }
  }

  private async startRequest(
    message: RequestMessage,
    signal: AbortSignal,
    operation: () => Promise<unknown> | unknown,
  ): Promise<void> {
    L.debug("request.start", {
      connectionId: this.connectionId,
      requestId: message.requestId,
      type: message.type,
    });
    const result = await settle(
      (async (): Promise<unknown> => {
        return await operation();
      })(),
    );
    if (this.disconnected || signal.aborted) {
      return;
    }
    if (result.ok) {
      L.debug("request.finish", {
        connectionId: this.connectionId,
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
    const error = serializedError(result.error);
    L.debug("request.error", {
      connectionId: this.connectionId,
      error,
      requestId: message.requestId,
      type: message.type,
    });
    this.emit({
      type: "error",
      requestId: message.requestId,
      error,
    });
  }

  private routeStoreMessage(
    message: RoutedMessage,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    if (this.registeredSignal !== signal) {
      throw new SharedDatabaseClientNotConnectedError();
    }
    switch (message.type) {
      case "query": {
        return this.store.set(
          queryStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
      case "get-computed": {
        return this.store.set(
          getComputedStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
      case "reload-computed": {
        return this.store.set(
          reloadComputedStoreMessage$,
          this.connectionId,
          message,
        );
      }
    }
  }

  private registerTab(devBrowserJwt: string | null): void {
    if (this.registeredSignal) {
      throw new Error("Shared database tab is already registered");
    }
    this.store.set(setWorkerDevBrowserJwt$, devBrowserJwt);
    const signal = this.store.set(
      registerConnection$,
      this.connectionId,
      this.connectionController,
      this.port,
      this.connectionSignal,
    );
    this.registeredSignal = signal;
    signal.addEventListener("abort", this.handleRegisteredConnectionAbort, {
      once: true,
    });
  }

  private disconnect(reason: string): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    L.debug("connection.disconnect", {
      connectionId: this.connectionId,
      reason,
    });
    this.port.removeEventListener("message", this.handleMessage);
    this.connectionSignal.removeEventListener(
      "abort",
      this.handleConnectionAbort,
    );
    this.registeredSignal?.removeEventListener(
      "abort",
      this.handleRegisteredConnectionAbort,
    );
    this.connectionController.abort(
      new DOMException(
        "Shared database MessagePort disconnected",
        "AbortError",
      ),
    );
    this.registeredSignal = null;
    this.port.close();
  }

  private readonly handleMessage = onDomEventFn(
    async (event: MessageEvent<unknown>): Promise<void> => {
      const parsed = sharedDatabaseClientMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        this.disconnect("invalid-message");
        const error = new Error("Invalid shared database client message");
        const details = {
          connectionId: this.connectionId,
          issueCount: parsed.error.issues.length,
        };
        L.debug("protocol.error", { ...details, error });
        captureSentryLogError("SharedDatabaseWorker", [error, details]);
        return;
      }
      const message = parsed.data;
      BridgeL.debug("got message from app", this.connectionId, message);
      if (message.type === "disconnect") {
        this.disconnect("client-request");
        return;
      }
      if (message.type === "register-tab") {
        this.registerTab(message.devBrowserJwt ?? null);
        return;
      }
      const registeredSignal = this.registeredSignal;
      if (!registeredSignal) {
        if ("requestId" in message) {
          await this.startRequest(message, this.connectionSignal, () => {
            throw new SharedDatabaseClientNotConnectedError();
          });
        }
        return;
      }
      if (message.type === "reload-computed") {
        this.routeStoreMessage(message, registeredSignal);
        return;
      }
      await this.startRequest(message, registeredSignal, () => {
        return this.routeStoreMessage(message, registeredSignal);
      });
    },
  );
}
