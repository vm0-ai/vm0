import type { Store } from "ccstate";

import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseCredentialId,
  type SharedDatabaseIdentity,
} from "./data-key.ts";
import {
  credentialStoreConnectionCount$,
  registerConnection$,
  unregisterConnection$,
  type ConnectionId,
} from "./worker-context.ts";
import {
  createSharedDatabaseCredentialStore,
  disposeSharedDatabaseCredentialStore$,
} from "./worker-signals.ts";

export interface SharedDatabaseConnectionBinding {
  readonly credentialId: string;
  readonly store: Store;
  readonly connectionId: ConnectionId;
}

export interface SharedDatabaseConnectionBindingUpdate {
  readonly binding: SharedDatabaseConnectionBinding;
  readonly signal: AbortSignal;
  readonly releasePrevious: () => void;
}

interface BindSharedDatabaseConnectionOptions {
  readonly connectionId: ConnectionId;
  readonly connectionController: AbortController;
  readonly port: SharedDatabasePortLike;
  readonly identity: SharedDatabaseIdentity;
  readonly apiBaseUrl: string;
  readonly vercelProtectionBypass: string | undefined;
}

export class SharedDatabaseWorkerContext {
  private readonly credentialStores = new Map<string, Store>();

  constructor(
    private readonly workerSignal: AbortSignal,
    readonly appVersion: string,
  ) {
    workerSignal.addEventListener(
      "abort",
      () => {
        for (const store of this.credentialStores.values()) {
          store.set(disposeSharedDatabaseCredentialStore$);
        }
        this.credentialStores.clear();
      },
      { once: true },
    );
  }

  bindConnection(
    options: BindSharedDatabaseConnectionOptions,
    previous: SharedDatabaseConnectionBinding | null,
    previousSignal: AbortSignal | null,
  ): SharedDatabaseConnectionBindingUpdate {
    this.workerSignal.throwIfAborted();
    const credentialId = sharedDatabaseCredentialId(options.identity);
    if (
      previous?.credentialId === credentialId &&
      previousSignal !== null &&
      !previousSignal.aborted
    ) {
      return {
        binding: previous,
        signal: previousSignal,
        releasePrevious: () => {},
      };
    }

    let store = this.credentialStores.get(credentialId);
    if (!store) {
      store = createSharedDatabaseCredentialStore(
        {
          appVersion: this.appVersion,
          identity: options.identity,
          apiBaseUrl: options.apiBaseUrl,
          vercelProtectionBypass: options.vercelProtectionBypass,
        },
        this.workerSignal,
      );
      this.credentialStores.set(credentialId, store);
    }
    const signal = store.set(
      registerConnection$,
      options.connectionId,
      options.connectionController,
      options.port,
      options.connectionController.signal,
    );
    const binding = { credentialId, store, connectionId: options.connectionId };
    signal.addEventListener(
      "abort",
      () => {
        this.releaseCredentialStore(credentialId, store);
      },
      { once: true },
    );
    return {
      binding,
      signal,
      releasePrevious: () => {
        if (!previous) {
          return;
        }
        previous.store.set(unregisterConnection$, previous.connectionId);
        this.releaseCredentialStore(previous.credentialId, previous.store);
      },
    };
  }

  credentialStoreCount(): number {
    return this.credentialStores.size;
  }

  private releaseCredentialStore(
    credentialId: string,
    expectedStore: unknown,
  ): void {
    const store = this.credentialStores.get(credentialId);
    if (
      !store ||
      store !== expectedStore ||
      store.get(credentialStoreConnectionCount$) > 0
    ) {
      return;
    }
    this.credentialStores.delete(credentialId);
    store.set(disposeSharedDatabaseCredentialStore$);
  }
}
