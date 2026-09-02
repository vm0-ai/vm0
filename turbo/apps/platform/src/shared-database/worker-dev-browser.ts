import { command, state } from "ccstate";

import { createDeferredPromise } from "../signals/utils.ts";

type DevBrowserJwtDeferred = ReturnType<typeof createDeferredPromise<string>>;

const devBrowserJwtDeferredState$ = state<DevBrowserJwtDeferred | null>(null);

/**
 * Resolves with the dev browser JWT the first registering tab hands over. Only
 * development Clerk instances need it, so nothing awaits this in production.
 */
export const awaitWorkerDevBrowserJwt$ = command(
  ({ set }, signal: AbortSignal): Promise<string> => {
    const deferred = createDeferredPromise<string>(signal);
    set(devBrowserJwtDeferredState$, deferred);
    return deferred.promise;
  },
);

export const setWorkerDevBrowserJwt$ = command(
  ({ get }, jwt: string | null): void => {
    const deferred = get(devBrowserJwtDeferredState$);
    if (!jwt || !deferred || deferred.settled()) {
      return;
    }
    deferred.resolve(jwt);
  },
);
