import { authContract } from "@okouai/api-contracts/contracts/auth";
import { createStore, type Store } from "ccstate";

import { accept } from "../lib/accept.ts";
import { captureSentryLogError } from "../lib/sentry-config.ts";
import { now } from "../lib/time.ts";
import { createAuthedContractClient } from "../signals/api-client-base.ts";
import type { AuthRecovery } from "../signals/auth-retry.ts";
import { logger } from "../signals/log.ts";
import {
  createChildAbortController,
  detach,
  Reason,
} from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseCredentialId,
  type SharedDatabaseIdentity,
} from "./data-key.ts";
import {
  sharedDatabaseClientMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import { reloadTabs$, type TabId } from "./worker-context.ts";
import {
  heartbeatStoreMessage$,
  indicatorsStoreMessage$,
  queryStoreMessage$,
  reloadIndicatorsStoreMessage$,
  runCredentialStoreDaemons$,
  subscribeStoreMessage$,
  unregisterSharedDatabaseWorkerTab$,
  unsubscribeStoreMessage$,
} from "./worker-signals.ts";

type CredentialId = string;

export interface SharedDatabaseWorkerMaps {
  readonly credentialStores: Map<CredentialId, Store>;
  readonly credentialAbortControllers: Map<CredentialId, AbortController>;
  readonly tabCredentialIds: Map<TabId, CredentialId>;
  readonly tabHeartbeatAts: Map<TabId, number>;
}

type RequestMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly requestId: string }
>;
type RoutedMessage = Exclude<
  SharedDatabaseClientMessage,
  { readonly type: "heartbeat" }
>;

const STALE_TAB_AFTER_MS = 3 * 60 * 1000;
const L = logger("SharedDatabaseWorker");
// A process-local monotonic transport ID is the trusted tab identity. It is
// intentionally not represented as ccstate business state.
// eslint-disable-next-line ccstate/no-package-variable
let nextTabId = 0;

const messageRoutes = {
  heartbeat: heartbeatStoreMessage$,
  query: queryStoreMessage$,
  subscribe: subscribeStoreMessage$,
  unsubscribe: unsubscribeStoreMessage$,
  "get-indicators": indicatorsStoreMessage$,
  "reload-indicators": reloadIndicatorsStoreMessage$,
} as const;

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
  onForceUpgrade: () => void,
  signal: AbortSignal,
): Promise<SharedDatabaseIdentity> {
  const authRecovery = fixedTokenAuthRecovery(message.token);
  const client = createAuthedContractClient(authContract, {
    baseUrl: message.apiBaseUrl,
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

export class SharedDatabaseMessagePortServer {
  private readonly tabId: TabId = nextTabId++;
  private closed = false;

  constructor(
    private readonly port: SharedDatabasePortLike,
    private readonly signal: AbortSignal,
    private readonly maps: SharedDatabaseWorkerMaps,
  ) {
    signal.throwIfAborted();
    port.addEventListener("message", this.handleMessage, { signal });
    port.start();
    signal.addEventListener(
      "abort",
      () => {
        this.closed = true;
        this.port.close();
      },
      { once: true },
    );
  }

  private readonly emit = (message: SharedDatabaseWorkerMessage): void => {
    if (!this.closed) {
      this.port.postMessage(message);
    }
  };

  private startRequest(
    message: RequestMessage,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<unknown> | unknown,
  ): void {
    const completion = (async (): Promise<void> => {
      const runOperation = async (): Promise<unknown> => {
        return await operation(signal);
      };
      const [result] = await Promise.allSettled([runOperation()]);
      if (this.closed || signal.aborted || !result) {
        return;
      }
      if (result.status === "fulfilled") {
        this.emit({
          type: "result",
          requestId: message.requestId,
          value: result.value,
        });
        return;
      }
      this.emit({
        type: "error",
        requestId: message.requestId,
        error: serializedError(result.reason),
      });
    })();
    detach(
      completion,
      Reason.Daemon,
      `shared database MessagePort request: ${message.type}`,
    );
  }

  private releaseTab(tabId: TabId, credentialId: CredentialId): void {
    const controller = this.maps.credentialAbortControllers.get(credentialId);
    if (!controller) {
      return;
    }
    if (this.maps.tabCredentialIds.get(tabId) === credentialId) {
      this.maps.tabCredentialIds.delete(tabId);
      this.maps.tabHeartbeatAts.delete(tabId);
    }
    const store = this.maps.credentialStores.get(credentialId);
    if (!store) {
      controller.abort(
        new DOMException("Credential Store was released", "AbortError"),
      );
      this.maps.credentialAbortControllers.delete(credentialId);
      return;
    }
    const remainingTabs = store.set(unregisterSharedDatabaseWorkerTab$, tabId);
    if (remainingTabs > 0) {
      return;
    }
    controller.abort(
      new DOMException("Credential Store was released", "AbortError"),
    );
    this.maps.credentialAbortControllers.delete(credentialId);
    this.maps.credentialStores.delete(credentialId);
  }

  private pruneStaleTabs(currentTime: number): void {
    for (const [tabId, lastHeartbeatAt] of this.maps.tabHeartbeatAts) {
      if (lastHeartbeatAt >= currentTime - STALE_TAB_AFTER_MS) {
        continue;
      }
      const credentialId = this.maps.tabCredentialIds.get(tabId);
      if (credentialId) {
        this.releaseTab(tabId, credentialId);
      }
    }
  }

  private routeStoreMessage(
    // The MessagePort callback resolves the trusted credential Store before
    // routing; Store must not cross any boundary below this method.
    // eslint-disable-next-line ccstate/no-store-in-params
    store: Store,
    message: RoutedMessage,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    switch (message.type) {
      case "query": {
        return store.set(messageRoutes.query, this.tabId, message, signal);
      }
      case "subscribe": {
        return store.set(messageRoutes.subscribe, this.tabId, message, signal);
      }
      case "unsubscribe": {
        return store.set(
          messageRoutes.unsubscribe,
          this.tabId,
          message,
          signal,
        );
      }
      case "get-indicators": {
        return store.set(
          messageRoutes["get-indicators"],
          this.tabId,
          message,
          signal,
        );
      }
      case "reload-indicators": {
        return store.set(
          messageRoutes["reload-indicators"],
          this.tabId,
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
  ): Promise<unknown> {
    const heartbeatAt = now();
    this.pruneStaleTabs(heartbeatAt);
    const identity = await authenticateHeartbeat(
      message,
      () => {
        this.emit({ type: "reload-required" });
        this.closed = true;
        this.port.close();
      },
      signal,
    );
    const credentialId = sharedDatabaseCredentialId(identity);
    const previousCredentialId = this.maps.tabCredentialIds.get(this.tabId);
    if (
      previousCredentialId !== undefined &&
      previousCredentialId !== credentialId
    ) {
      this.releaseTab(this.tabId, previousCredentialId);
    }

    let store = this.maps.credentialStores.get(credentialId);
    let controller = this.maps.credentialAbortControllers.get(credentialId);
    if (
      controller?.signal.aborted ||
      (store === undefined) !== (controller === undefined)
    ) {
      controller?.abort(
        new DOMException("Credential Store was replaced", "AbortError"),
      );
      this.maps.credentialStores.delete(credentialId);
      this.maps.credentialAbortControllers.delete(credentialId);
      for (const [tabId, mappedCredentialId] of this.maps.tabCredentialIds) {
        if (mappedCredentialId === credentialId) {
          this.maps.tabCredentialIds.delete(tabId);
          this.maps.tabHeartbeatAts.delete(tabId);
        }
      }
      store = undefined;
      controller = undefined;
    }
    const created = store === undefined;
    if (!store) {
      store = createStore();
      controller = createChildAbortController(this.signal);
      this.maps.credentialStores.set(credentialId, store);
      this.maps.credentialAbortControllers.set(credentialId, controller);
    }
    if (!controller) {
      throw new Error("Credential Store is missing its AbortController");
    }

    const register =
      this.maps.tabCredentialIds.get(this.tabId) !== credentialId;
    const result = await store.set(
      messageRoutes.heartbeat,
      this.tabId,
      {
        message,
        identity,
        emit: this.emit,
        register,
        onForceUpgrade: () => {
          store.set(reloadTabs$);
          controller.abort(
            new DOMException(
              "Credential Store requires a newer client",
              "AbortError",
            ),
          );
        },
      },
      controller.signal,
    );
    this.maps.tabCredentialIds.set(this.tabId, credentialId);
    this.maps.tabHeartbeatAts.set(this.tabId, heartbeatAt);
    if (created) {
      detach(
        store.set(runCredentialStoreDaemons$, controller.signal),
        Reason.Daemon,
        `shared database credential daemons: ${credentialId}`,
      );
    }
    return result;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const parsed = sharedDatabaseClientMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      const credentialId = this.maps.tabCredentialIds.get(this.tabId);
      if (credentialId) {
        this.releaseTab(this.tabId, credentialId);
      }
      this.closed = true;
      this.port.close();
      const error = new Error("Invalid shared database client message");
      const details = {
        tabId: this.tabId,
        issueCount: parsed.error.issues.length,
      };
      L.debug("protocol.error", { ...details, error });
      captureSentryLogError("SharedDatabaseWorker", [error, details]);
      return;
    }
    const message = parsed.data;
    if (message.type === "heartbeat") {
      this.startRequest(message, this.signal, (signal) => {
        return this.routeHeartbeat(message, signal);
      });
      return;
    }

    const credentialId = this.maps.tabCredentialIds.get(this.tabId);
    if (!credentialId) {
      return;
    }
    const store = this.maps.credentialStores.get(credentialId);
    const controller = this.maps.credentialAbortControllers.get(credentialId);
    if (!store || !controller || controller.signal.aborted) {
      return;
    }
    if (
      message.type === "unsubscribe" ||
      message.type === "reload-indicators"
    ) {
      this.routeStoreMessage(store, message, controller.signal);
      return;
    }
    this.startRequest(message, controller.signal, (signal) => {
      return this.routeStoreMessage(store, message, signal);
    });
  };
}
