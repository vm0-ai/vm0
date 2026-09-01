import type { Store } from "ccstate";

import { detach, Reason } from "../signals/utils.ts";
import type { SharedDatabasePortLike } from "./bridge.ts";
import {
  sharedDatabaseCredentialId,
  type SharedDatabaseIdentity,
} from "./data-key.ts";
import {
  credentialStoreConnectionCount$,
  registerConnection$,
  type ConnectionId,
} from "./worker-context.ts";
import {
  createSharedDatabaseCredentialStore,
  disposeSharedDatabaseCredentialStore$,
  startCredentialStoreDaemons$,
} from "./worker-signals.ts";

export interface SharedDatabaseConnectionBinding {
  readonly credentialId: string;
  readonly store: Store;
}

interface SharedDatabaseConnectionRegistration {
  readonly binding: SharedDatabaseConnectionBinding;
  readonly signal: AbortSignal;
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
  ): SharedDatabaseConnectionRegistration {
    this.workerSignal.throwIfAborted();
    const credentialId = sharedDatabaseCredentialId(options.identity);
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
    const binding = { credentialId, store };
    signal.addEventListener(
      "abort",
      () => {
        this.releaseCredentialStore(credentialId, store);
      },
      { once: true },
    );
    return { binding, signal };
  }

  startCredentialStoreDaemons(credentialId: string): void {
    const store = this.credentialStores.get(credentialId);
    if (!store) {
      throw new Error("Shared database credential Store was not found");
    }
    const daemon = store.set(startCredentialStoreDaemons$);
    if (daemon) {
      detach(daemon, Reason.Daemon, "shared database credential realtime");
    }
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
