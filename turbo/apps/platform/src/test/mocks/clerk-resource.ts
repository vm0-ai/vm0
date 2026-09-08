import { createStore, state } from "ccstate";

import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { createDeferredPromise } from "../../signals/utils.ts";

interface ClerkResourceOptions {
  readonly domain?: string;
  readonly publishableKey: string;
}

interface ClerkResourceRequest {
  readonly domain: string | undefined;
  readonly publishableKey: string;
}

interface ClerkResourceMock {
  readonly requests: ClerkResourceRequest[];
  readonly pending: () => ReturnType<typeof createDeferredPromise<void>>;
  readonly unavailable: (error?: Error) => void;
}

interface ClerkResourceBehavior {
  failure: Error | null;
  gate: Promise<void>;
  readonly requests: ClerkResourceRequest[];
}

const activeBehavior$ = state<ClerkResourceBehavior | null>(null);
const behaviorStore = createStore();

export function mockClerkResource(signal: AbortSignal): ClerkResourceMock {
  const behavior: ClerkResourceBehavior = {
    failure: null,
    gate: Promise.resolve(),
    requests: [],
  };
  behaviorStore.set(activeBehavior$, behavior);
  signal.addEventListener(
    "abort",
    () => {
      if (behaviorStore.get(activeBehavior$) === behavior) {
        behaviorStore.set(activeBehavior$, null);
      }
      Reflect.deleteProperty(globalThis, "Clerk");
    },
    { once: true },
  );

  return {
    requests: behavior.requests,
    pending() {
      const deferred = createDeferredPromise<void>(signal);
      behavior.gate = deferred.promise;
      return deferred;
    },
    unavailable(error = new Error("Clerk resource is unavailable")): void {
      behavior.failure = error;
    },
  };
}

export async function loadClerkJSScript(
  options: ClerkResourceOptions,
): Promise<null> {
  if (Reflect.has(globalThis, "Clerk")) {
    return null;
  }
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    throw new Error("Clerk resource behavior was not configured");
  }
  behavior.requests.push({
    domain: options.domain,
    publishableKey: options.publishableKey,
  });
  await behavior.gate;
  if (behavior.failure) {
    throw behavior.failure;
  }
  if (options.domain) {
    mockedClerk.initialize(options.publishableKey, { domain: options.domain });
  } else {
    mockedClerk.initialize(options.publishableKey);
  }
  Reflect.set(globalThis, "Clerk", mockedClerk);
  return null;
}
