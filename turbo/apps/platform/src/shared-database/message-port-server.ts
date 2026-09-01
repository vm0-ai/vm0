import { authContract } from "@okouai/api-contracts/contracts/auth";

import { accept } from "../lib/accept.ts";
import { captureSentryLogError } from "../lib/sentry-config.ts";
import { createAuthedContractClient } from "../signals/api-client-base.ts";
import type { AuthRecovery } from "../signals/auth-retry.ts";
import { logger } from "../signals/log.ts";
import {
  createChildAbortController,
  onDomEventFn,
  settle,
} from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseCredentialId,
  type SharedDatabaseIdentity,
} from "./data-key.ts";
import {
  sharedDatabaseClientMessageSchema,
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseClientMessage,
  type SharedDatabaseHeartbeatResult,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import {
  SharedDatabaseWorkerContext,
  type SharedDatabaseConnectionBinding,
} from "./worker-host-context.ts";
import {
  heartbeatStoreMessage$,
  indicatorsStoreMessage$,
  queryStoreMessage$,
  reloadIndicatorsStoreMessage$,
} from "./worker-signals.ts";

type RequestMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly requestId: string }
>;
type RoutedMessage = Exclude<
  SharedDatabaseClientMessage,
  { readonly type: "disconnect" | "heartbeat" }
>;

const L = logger("SharedDatabaseWorker");

function serializedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: Error.name, message: String(error) };
}

function fixedTokenAuthRecovery(token: string): AuthRecovery {
  return {
    getToken: (signal) => {
      signal.throwIfAborted();
      return Promise.resolve(token);
    },
    forceRefreshToken: (signal) => {
      signal.throwIfAborted();
      return Promise.resolve(null);
    },
  };
}

async function authenticateHeartbeat(
  message: Extract<SharedDatabaseClientMessage, { readonly type: "heartbeat" }>,
  clientVersion: string,
  onForceUpgrade: () => void,
  signal: AbortSignal,
): Promise<SharedDatabaseIdentity> {
  const authRecovery = fixedTokenAuthRecovery(message.token);
  const client = createAuthedContractClient(authContract, {
    baseUrl: message.apiBaseUrl,
    clientVersion,
    getAuthRecovery: () => {
      return Promise.resolve(authRecovery);
    },
    getRootSignal: () => {
      return signal;
    },
    getVercelProtectionBypass: () => {
      return message.vercelProtectionBypass;
    },
    onForceUpgrade,
  });
  const result = await accept(
    client.me({ fetchOptions: { signal } }),
    [200],
    signal,
    { showErrorToast: false },
  );
  if (typeof result.body.orgId !== "string") {
    throw new Error("Shared database requires an organization credential");
  }
  return {
    userId: result.body.userId,
    orgId: result.body.orgId,
    token: message.token,
  };
}

class SharedDatabaseClientNotConnectedError extends Error {
  constructor() {
    super("Shared database heartbeat is required before query");
    this.name = SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME;
  }
}

export class SharedDatabaseMessagePortServer {
  private readonly connectionId = crypto.randomUUID();
  private readonly connectionController: AbortController;
  private readonly connectionSignal: AbortSignal;
  private binding: SharedDatabaseConnectionBinding | null = null;
  private credentialConnectionSignal: AbortSignal | null = null;
  private credentialReady = false;
  private disconnected = false;

  constructor(
    private readonly context: SharedDatabaseWorkerContext,
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

  private readonly handleCredentialConnectionAbort = (): void => {
    this.disconnect("credential-abort");
  };

  private emit(message: SharedDatabaseWorkerMessage): void {
    if (!this.disconnected) {
      this.port.postMessage(message);
    }
  }

  private async startRequest(
    message: RequestMessage,
    signal: AbortSignal,
    operation: () => Promise<unknown> | unknown,
  ): Promise<boolean> {
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
      return false;
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
      return true;
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
    return false;
  }

  private routeStoreMessage(
    message: RoutedMessage,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    const binding = this.binding;
    if (
      !binding ||
      !this.credentialReady ||
      this.credentialConnectionSignal !== signal
    ) {
      throw new SharedDatabaseClientNotConnectedError();
    }
    const store = binding.store;
    switch (message.type) {
      case "query": {
        return store.set(
          queryStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
      case "get-indicators": {
        return store.set(
          indicatorsStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
      case "reload-indicators": {
        return store.set(
          reloadIndicatorsStoreMessage$,
          this.connectionId,
          message,
        );
      }
    }
  }

  private async routeHeartbeat(
    message: Extract<
      SharedDatabaseClientMessage,
      { readonly type: "heartbeat" }
    >,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    const identity = await authenticateHeartbeat(
      message,
      this.context.appVersion,
      () => {
        this.emit({ type: "reload-required" });
        this.disconnect("force-upgrade");
      },
      signal,
    );
    signal.throwIfAborted();
    const credentialId = sharedDatabaseCredentialId(identity);
    const currentBinding = this.binding;
    if (currentBinding) {
      if (currentBinding.credentialId !== credentialId) {
        return this.reloadAfterCredentialChange();
      }
      return this.heartbeatBoundConnection(
        currentBinding,
        message,
        identity,
        signal,
      );
    }
    const update = this.context.bindConnection({
      connectionId: this.connectionId,
      connectionController: this.connectionController,
      port: this.port,
      identity,
      apiBaseUrl: message.apiBaseUrl,
      vercelProtectionBypass: message.vercelProtectionBypass,
    });
    const { binding, signal: credentialConnectionSignal } = update;
    this.setCredentialBinding(binding, credentialConnectionSignal);
    return this.heartbeatBoundConnection(binding, message, identity, signal);
  }

  private heartbeatBoundConnection(
    binding: SharedDatabaseConnectionBinding,
    message: Extract<
      SharedDatabaseClientMessage,
      { readonly type: "heartbeat" }
    >,
    identity: SharedDatabaseIdentity,
    signal: AbortSignal,
  ): SharedDatabaseHeartbeatResult {
    const credentialConnectionSignal = this.credentialConnectionSignal;
    if (!credentialConnectionSignal || binding !== this.binding) {
      throw new SharedDatabaseClientNotConnectedError();
    }
    const result = binding.store.set(
      heartbeatStoreMessage$,
      this.connectionId,
      message,
      identity,
      credentialConnectionSignal,
    );
    this.context.startCredentialStoreDaemons(binding.credentialId);
    signal.throwIfAborted();
    credentialConnectionSignal.throwIfAborted();
    this.credentialReady = true;
    return result;
  }

  private reloadAfterCredentialChange(): never {
    const reason = new DOMException(
      "Shared database MessagePort credential changed",
      "AbortError",
    );
    this.connectionSignal.removeEventListener(
      "abort",
      this.handleConnectionAbort,
    );
    this.credentialConnectionSignal?.removeEventListener(
      "abort",
      this.handleCredentialConnectionAbort,
    );
    this.connectionController.abort(reason);
    this.emit({ type: "reload-required" });
    this.disconnect("credential-changed");
    throw reason;
  }

  private setCredentialBinding(
    binding: SharedDatabaseConnectionBinding,
    signal: AbortSignal,
  ): void {
    if (this.binding || this.credentialConnectionSignal) {
      throw new Error("Shared database MessagePort credential is immutable");
    }
    this.binding = binding;
    this.credentialConnectionSignal = signal;
    signal.addEventListener("abort", this.handleCredentialConnectionAbort, {
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
    this.credentialConnectionSignal?.removeEventListener(
      "abort",
      this.handleCredentialConnectionAbort,
    );
    this.connectionController.abort(
      new DOMException(
        "Shared database MessagePort disconnected",
        "AbortError",
      ),
    );
    this.binding = null;
    this.credentialConnectionSignal = null;
    this.credentialReady = false;
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
      if (message.type === "disconnect") {
        this.disconnect("client-request");
        return;
      }
      if (message.type === "heartbeat") {
        await this.startRequest(message, this.connectionSignal, () => {
          return this.routeHeartbeat(message, this.connectionSignal);
        });
        return;
      }
      const binding = this.binding;
      const credentialConnectionSignal = this.credentialConnectionSignal;
      if (!binding || !credentialConnectionSignal) {
        if ("requestId" in message) {
          await this.startRequest(message, this.connectionSignal, () => {
            throw new SharedDatabaseClientNotConnectedError();
          });
        }
        return;
      }
      if (message.type === "reload-indicators") {
        this.routeStoreMessage(message, credentialConnectionSignal);
        return;
      }
      await this.startRequest(message, credentialConnectionSignal, () => {
        return this.routeStoreMessage(message, credentialConnectionSignal);
      });
    },
  );
}
