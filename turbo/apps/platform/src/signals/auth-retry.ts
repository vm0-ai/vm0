/**
 * Auth recovery shared by foreground catch-up and authenticated requests.
 *
 * Every recovery trigger joins the same root-owned Clerk refresh. Request
 * cancellation stops only that request from waiting; it does not interrupt the
 * shared refresh used by the rest of the app.
 */
import { command, state } from "ccstate";
import type { Clerk } from "@clerk/clerk-js";
import { isNetworkRequestError } from "../lib/network-error.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  retryWithFibonacciBackoff,
  withCleanup,
} from "./utils";

type ClerkLike = Pick<Clerk, "session" | "addListener" | "redirectToSignIn">;

export interface AuthRecovery {
  readonly getToken: (signal?: AbortSignal) => Promise<string | null>;
  readonly refreshAuth: (signal?: AbortSignal) => Promise<string | null>;
}

const FOREGROUND_CATCH_UP_EVENT = "catch-up";
const FOREGROUND_CATCH_UP_REQUEST_EVENT = "request-catch-up";

const foregroundCatchUpTarget$ = state(new EventTarget());

export const subscribeForegroundCatchUp$ = command(
  ({ get }, callback: () => void, signal: AbortSignal) => {
    get(foregroundCatchUpTarget$).addEventListener(
      FOREGROUND_CATCH_UP_EVENT,
      callback,
      { signal },
    );
  },
);

export const requestForegroundCatchUp$ = command(({ get }) => {
  if (document.visibilityState !== "visible") {
    return;
  }
  get(foregroundCatchUpTarget$).dispatchEvent(
    new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT),
  );
});

/**
 * Create the single auth-recovery owner for the current Clerk/root lifecycle.
 */
export function createAuthRecovery(
  clerk: ClerkLike,
  rootSignal: AbortSignal,
): AuthRecovery {
  let refreshPromise: Promise<string | null> | null = null;

  const refreshAuth = (signal?: AbortSignal): Promise<string | null> => {
    if (!refreshPromise) {
      const refresh = withCleanup(runAuthRefresh(clerk, rootSignal), () => {
        if (refreshPromise === refresh) {
          refreshPromise = null;
        }
      });
      refreshPromise = refresh;
    }
    return waitForAuthRecovery(
      refreshPromise,
      recoveryWaitSignal(rootSignal, signal),
    );
  };

  return {
    getToken: (signal?: AbortSignal) => {
      const tokenPromise = refreshPromise ?? readCachedToken(clerk);
      return waitForAuthRecovery(
        tokenPromise,
        recoveryWaitSignal(rootSignal, signal),
      );
    },
    refreshAuth,
  };
}

/**
 * Route visibility, focus, and realtime reconnect through one catch-up task.
 */
export const setupAuthCatchUp$ = command(
  ({ get }, authRecovery: AuthRecovery, signal: AbortSignal): void => {
    const catchUpTarget = get(foregroundCatchUpTarget$);
    let catchUpPromise: Promise<void> | null = null;

    const catchUpAfterAuth = (): Promise<void> => {
      if (!catchUpPromise) {
        const catchUp = withCleanup(
          (async () => {
            const token = await authRecovery.refreshAuth(signal);
            signal.throwIfAborted();
            if (!token || document.visibilityState !== "visible") {
              return;
            }
            catchUpTarget.dispatchEvent(new Event(FOREGROUND_CATCH_UP_EVENT));
          })(),
          () => {
            if (catchUpPromise === catchUp) {
              catchUpPromise = null;
            }
          },
        );
        catchUpPromise = catchUp;
      }
      return catchUpPromise;
    };

    catchUpTarget.addEventListener(
      FOREGROUND_CATCH_UP_REQUEST_EVENT,
      onDomEventFn(async () => {
        await catchUpAfterAuth();
      }),
      { signal },
    );

    const requestCatchUp = (): void => {
      if (document.visibilityState === "visible") {
        catchUpTarget.dispatchEvent(
          new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT),
        );
      }
    };
    document.addEventListener("visibilitychange", requestCatchUp, { signal });
    window.addEventListener("focus", requestCatchUp, { signal });
  },
);

type SettledClerkSession = Exclude<Clerk["session"], undefined>;

function waitForSettledClerkSession(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<SettledClerkSession> {
  signal.throwIfAborted();

  if (clerk.session !== undefined) {
    return Promise.resolve(clerk.session);
  }

  const deferred = createDeferredPromise<SettledClerkSession>(signal);
  const resolveIfSettled = (session: Clerk["session"]): void => {
    if (session === undefined) {
      return;
    }
    signal.removeEventListener("abort", unsubscribe);
    unsubscribe();
    deferred.resolve(session);
  };
  const unsubscribe = clerk.addListener(
    ({ session }) => {
      resolveIfSettled(session);
    },
    { skipInitialEmit: true },
  );
  signal.addEventListener("abort", unsubscribe, { once: true });

  // Close the race between the initial read and listener registration.
  resolveIfSettled(clerk.session);

  return deferred.promise;
}

type AuthRefreshAttempt =
  | { readonly status: "active"; readonly token: string | null }
  | { readonly status: "signed-out" };

async function runAuthRefresh(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await retryAuthRecoveryOperation(() => {
    return refreshClerkSession(clerk, signal);
  }, signal);

  if (result.status === "signed-out") {
    if (document.visibilityState === "visible") {
      await clerk.redirectToSignIn();
    }
    return null;
  }
  return result.token;
}

async function refreshClerkSession(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<AuthRefreshAttempt> {
  const session = await waitForSettledClerkSession(clerk, signal);
  if (session === null) {
    return { status: "signed-out" };
  }

  await session.touch({ intent: "focus" });
  signal.throwIfAborted();

  // Clerk may replace or clear the session while touch is in flight.
  const refreshedSession = await waitForSettledClerkSession(clerk, signal);
  if (refreshedSession === null) {
    return { status: "signed-out" };
  }

  const token = await refreshedSession.getToken({ skipCache: true });
  signal.throwIfAborted();
  return { status: "active", token };
}

async function readCachedToken(clerk: ClerkLike): Promise<string | null> {
  return (await clerk.session?.getToken()) ?? null;
}

function recoveryWaitSignal(
  rootSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
): AbortSignal {
  return requestSignal
    ? AbortSignal.any([rootSignal, requestSignal])
    : rootSignal;
}

function waitForAuthRecovery<T>(
  recovery: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([recovery, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Auth recovery settled", "AbortError"));
    }
  });
}

function isClerkOfflineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "clerk_offline"
  );
}

function isClerkNetworkError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("ClerkJS: Network error")
  );
}

function isAuthRecoveryNetworkError(error: unknown): boolean {
  return (
    isClerkOfflineError(error) ||
    isClerkNetworkError(error) ||
    isNetworkRequestError(error)
  );
}

function retryAuthRecoveryOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return retryWithFibonacciBackoff(
    operation,
    isAuthRecoveryNetworkError,
    signal,
  );
}
