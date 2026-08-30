import { command, state } from "ccstate";

import { createDeferredPromise, withCleanup } from "../signals/utils.ts";
import type { AuthRecovery } from "../signals/auth-retry.ts";
import type { SharedDatabaseIdentity } from "./data-key.ts";
import type { WorkerClientEmitter } from "./worker-runtime.ts";

export type TabId = number;

interface TabRegistration {
  readonly id: TabId;
  readonly emit: WorkerClientEmitter;
}

interface TokenWaiter {
  readonly rejectedToken: string;
  readonly deferred: ReturnType<typeof createDeferredPromise<string | null>>;
}

class WorkerAuthRecovery implements AuthRecovery {
  private readonly waiters = new Set<TokenWaiter>();
  private tabs: ReadonlyMap<TabId, TabRegistration> = new Map();

  constructor(private token: string) {}

  getToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return Promise.resolve(this.token);
  }

  forceRefreshToken(signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    for (const tab of this.tabs.values()) {
      tab.emit({ type: "authentication-required" });
    }
    const waiter: TokenWaiter = {
      rejectedToken: this.token,
      deferred: createDeferredPromise<string | null>(signal),
    };
    this.waiters.add(waiter);
    return withCleanup(waiter.deferred.promise, () => {
      this.waiters.delete(waiter);
    });
  }

  updateToken(token: string): void {
    this.token = token;
    for (const waiter of this.waiters) {
      if (waiter.rejectedToken !== token && !waiter.deferred.settled()) {
        waiter.deferred.resolve(token);
      }
    }
  }

  updateTabs(tabs: ReadonlyMap<TabId, TabRegistration>): void {
    this.tabs = tabs;
  }
}

interface WorkerCredentialContext {
  readonly identity: SharedDatabaseIdentity;
  readonly authRecovery: WorkerAuthRecovery;
}

const internalWorkerCredentialContext$ = state<WorkerCredentialContext | null>(
  null,
);
const internalTabs$ = state<ReadonlyMap<TabId, TabRegistration>>(new Map());

function requireWorkerCredentialContext(
  context: WorkerCredentialContext | null,
): WorkerCredentialContext {
  if (!context) {
    throw new Error("Worker credential context was not initialized");
  }
  return context;
}

export const initializeWorkerCredentialContext$ = command(
  ({ get, set }, identity: SharedDatabaseIdentity): AuthRecovery => {
    const existing = get(internalWorkerCredentialContext$);
    if (existing) {
      if (
        existing.identity.userId !== identity.userId ||
        existing.identity.orgId !== identity.orgId
      ) {
        throw new Error("Worker credential Store identity cannot change");
      }
      existing.authRecovery.updateToken(identity.token);
      return existing.authRecovery;
    }
    const authRecovery = new WorkerAuthRecovery(identity.token);
    set(internalWorkerCredentialContext$, { identity, authRecovery });
    return authRecovery;
  },
);

export const registerTab$ = command(
  ({ get, set }, tabId: TabId, emit: WorkerClientEmitter): number => {
    const authRecovery = requireWorkerCredentialContext(
      get(internalWorkerCredentialContext$),
    ).authRecovery;
    let size = 0;
    set(internalTabs$, (tabs) => {
      const updatedTabs = new Map(tabs);
      updatedTabs.set(tabId, { id: tabId, emit });
      authRecovery.updateTabs(updatedTabs);
      size = updatedTabs.size;
      return updatedTabs;
    });
    return size;
  },
);

export const unregisterTab$ = command(({ get, set }, tabId: TabId): number => {
  const authRecovery = requireWorkerCredentialContext(
    get(internalWorkerCredentialContext$),
  ).authRecovery;
  let size = 0;
  set(internalTabs$, (tabs) => {
    const updatedTabs = new Map(tabs);
    updatedTabs.delete(tabId);
    authRecovery.updateTabs(updatedTabs);
    size = updatedTabs.size;
    return updatedTabs;
  });
  return size;
});

export const invalidateTabIndicators$ = command(({ get }): void => {
  for (const tab of get(internalTabs$).values()) {
    tab.emit({ type: "indicators-invalidated" });
  }
});

export const reloadTabs$ = command(({ get }): void => {
  for (const tab of get(internalTabs$).values()) {
    tab.emit({ type: "reload-required" });
  }
});
