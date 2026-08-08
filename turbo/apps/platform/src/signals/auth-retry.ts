/**
 * Auth retry helpers shared by `fetch$` (signals/fetch.ts) and
 * `zeroClient$` (signals/api-client.ts).
 *
 * On a 401 response we refresh Clerk and replay the request. A request that
 * observes an active foreground recovery joins that exact task; every other
 * request touches the session itself. Network failures during recovery or
 * replay retry with fibonacci backoff. Only an explicit 401 after recovery
 * falls back to `clerk.redirectToSignIn()`.
 */
import { command, computed, state } from "ccstate";
import type { Clerk } from "@clerk/clerk-js";
import { isNetworkRequestError } from "../lib/network-error.ts";
import { now } from "../lib/time.ts";
import {
  createDeferredPromise,
  detach,
  Reason,
  retryWithFibonacciBackoff,
  withCleanup,
} from "./utils";

export type ClerkLike = Pick<
  Clerk,
  "session" | "addListener" | "redirectToSignIn"
>;

const AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS = 30_000;

type FreshTokenResult =
  | { readonly status: "refreshed"; readonly token: string }
  | { readonly status: "unavailable" };

const unauthorizedRedirectSuppressionUntilState$ = state(0);
const internalForegroundAuthRecovery$ = state<Promise<boolean> | null>(null);

export const unauthorizedRedirectSuppressionUntil$ = computed((get) => {
  return get(unauthorizedRedirectSuppressionUntilState$);
});

export const foregroundAuthRecovery$ = computed((get) => {
  return get(internalForegroundAuthRecovery$);
});

export const setForegroundAuthRecovery$ = command(
  ({ set }, recovery: Promise<boolean>) => {
    set(internalForegroundAuthRecovery$, recovery);
  },
);

export const clearForegroundAuthRecovery$ = command(
  ({ get, set }, recovery: Promise<boolean>) => {
    if (get(internalForegroundAuthRecovery$) === recovery) {
      set(internalForegroundAuthRecovery$, null);
    }
  },
);

export const suppressUnauthorizedRedirectForAuthTransition$ = command(
  ({ get, set }) => {
    set(
      unauthorizedRedirectSuppressionUntilState$,
      Math.max(
        get(unauthorizedRedirectSuppressionUntilState$),
        now() + AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS,
      ),
    );
  },
);

function isUnauthorizedRedirectSuppressed(suppressionUntil: number): boolean {
  return now() < suppressionUntil;
}

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

/**
 * Refresh the Clerk session token. Network failures retry until the request's
 * owning signal aborts, so a temporarily offline browser does not turn into a
 * sign-in redirect. Only a request that joins a successful active foreground
 * recovery can reuse its completed session touch.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  signal: AbortSignal,
  foregroundRecovery: Promise<boolean> | null = null,
): Promise<FreshTokenResult> {
  const session = await waitForSettledClerkSession(clerk, signal);
  if (session === null) {
    return { status: "unavailable" };
  }

  const foregroundReady = foregroundRecovery
    ? await waitForForegroundRecovery(foregroundRecovery, signal)
    : false;

  const token = await retryAuthRecoveryOperation(async () => {
    if (!foregroundReady) {
      await session.touch({ intent: "focus" });
      signal.throwIfAborted();
    }
    return session.getToken({ skipCache: true });
  }, signal);
  if (!token) {
    return { status: "unavailable" };
  }
  return { status: "refreshed", token };
}

function waitForForegroundRecovery(
  recovery: Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([recovery, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(
        new DOMException("Foreground recovery settled", "AbortError"),
      );
    }
  });
}

/**
 * Resume Clerk's foreground session before visibility-driven data catch-up.
 * The caller owns foreground lifecycle coalescing and cancellation.
 */
export async function resumeClerkSession(
  clerk: ClerkLike,
  expectedOrgId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const session = await waitForSettledClerkSession(clerk, signal);
  if (session === null) {
    return false;
  }

  const token = await retryAuthRecoveryOperation(async () => {
    await session.touch({ intent: "focus" });
    signal.throwIfAborted();
    return session.getToken({ skipCache: true });
  }, signal);
  return Boolean(token && session.lastActiveOrganizationId === expectedOrgId);
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

export function retryAuthRecoveryOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return retryWithFibonacciBackoff(
    operation,
    isAuthRecoveryNetworkError,
    signal,
  );
}

export function authRecoverySignal(
  rootSignal: AbortSignal,
  requestSignal: AbortSignal | null | undefined,
): AbortSignal {
  return requestSignal
    ? AbortSignal.any([rootSignal, requestSignal])
    : rootSignal;
}

export function handleUnauthorizedRedirect(
  clerk: ClerkLike,
  suppressionUntil: number,
) {
  // A hidden PWA can receive 401s before Clerk finishes resuming its session.
  // Leave navigation to the next visible request's recovery attempt.
  if (
    document.visibilityState !== "visible" ||
    isUnauthorizedRedirectSuppressed(suppressionUntil)
  ) {
    return;
  }
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line ccstate/no-detach-in-signals
  detach(clerk.redirectToSignIn(), Reason.Entrance);
}
