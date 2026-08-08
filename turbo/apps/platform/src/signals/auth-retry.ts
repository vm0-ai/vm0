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
import { foregroundAuthRecoveryEnabled$ } from "./external/feature-switch-state.ts";
import { logger } from "./log.ts";
import {
  createDeferredPromise,
  detach,
  onDomEventFn,
  Reason,
  resetSignal,
  retryWithFibonacciBackoff,
  withCleanup,
} from "./utils";

export type ClerkLike = Pick<
  Clerk,
  "session" | "organization" | "addListener" | "redirectToSignIn"
>;

const AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS = 30_000;
const FOREGROUND_CATCH_UP_EVENT = "catch-up";

const L = logger("AuthRecovery");

type FreshTokenResult =
  | { readonly status: "refreshed"; readonly token: string }
  | { readonly status: "unavailable" };

const unauthorizedRedirectSuppressionUntilState$ = state(0);
const internalForegroundAuthRecovery$ = state<Promise<boolean> | null>(null);
const foregroundCatchUpTarget$ = state(new EventTarget());
const resetForegroundRecoverySignal$ = resetSignal();

export const unauthorizedRedirectSuppressionUntil$ = computed((get) => {
  return get(unauthorizedRedirectSuppressionUntilState$);
});

export const foregroundAuthRecovery$ = computed((get) => {
  return get(internalForegroundAuthRecovery$);
});

const setForegroundAuthRecovery$ = command(
  ({ set }, recovery: Promise<boolean>) => {
    set(internalForegroundAuthRecovery$, recovery);
  },
);

const clearForegroundAuthRecovery$ = command(
  ({ get, set }, recovery: Promise<boolean>) => {
    if (get(internalForegroundAuthRecovery$) === recovery) {
      set(internalForegroundAuthRecovery$, null);
    }
  },
);

/**
 * Subscribe to the centralized foreground catch-up gate. While the rollout is
 * disabled, visibility resumes are emitted immediately to preserve the legacy
 * realtime behavior. While enabled, they are emitted only after Clerk has
 * touched the session and refreshed the active organization's token.
 */
export const subscribeForegroundCatchUp$ = command(
  ({ get }, callback: () => void, signal: AbortSignal) => {
    get(foregroundCatchUpTarget$).addEventListener(
      FOREGROUND_CATCH_UP_EVENT,
      callback,
      { signal },
    );
  },
);

/**
 * Own Clerk foreground session touch for every rollout state. Clerk's load
 * options are one-shot, while feature-switch hydration is asynchronous, so
 * ownership cannot safely be selected in `Clerk.load()`. The switch controls
 * only whether downstream catch-up waits for this shared recovery.
 */
export const setupForegroundAuthRecovery$ = command(
  ({ get, set }, clerk: ClerkLike, signal: AbortSignal) => {
    let foregroundRecovery: Promise<boolean> | undefined;
    let notifyAfterRecovery = false;
    let catchUpNotified = false;

    const notifyCatchUp = (): void => {
      if (catchUpNotified) {
        return;
      }
      catchUpNotified = true;
      get(foregroundCatchUpTarget$).dispatchEvent(
        new Event(FOREGROUND_CATCH_UP_EVENT),
      );
    };

    const abortForegroundRecovery = (): void => {
      set(resetForegroundRecoverySignal$);
      if (foregroundRecovery) {
        set(clearForegroundAuthRecovery$, foregroundRecovery);
      }
      foregroundRecovery = undefined;
      notifyAfterRecovery = false;
      catchUpNotified = false;
    };

    const recoverForeground = (
      waitBeforeCatchUp: boolean,
    ): Promise<boolean> => {
      notifyAfterRecovery ||= waitBeforeCatchUp;
      if (foregroundRecovery) {
        return foregroundRecovery;
      }

      catchUpNotified = false;
      const expectedOrgId = clerk.organization?.id ?? null;
      const recoverySignal = set(resetForegroundRecoverySignal$, signal);
      const recovery = withCleanup(
        (async () => {
          const ready = await resumeClerkSession(
            clerk,
            expectedOrgId,
            recoverySignal,
          );
          recoverySignal.throwIfAborted();
          if (!ready) {
            return false;
          }
          if (notifyAfterRecovery) {
            L.debug("foreground auth ready, notifying catch-up subscribers");
            notifyCatchUp();
          }
          return true;
        })(),
        () => {
          if (foregroundRecovery === recovery) {
            foregroundRecovery = undefined;
            notifyAfterRecovery = false;
            catchUpNotified = false;
          }
          set(clearForegroundAuthRecovery$, recovery);
        },
      );
      foregroundRecovery = recovery;
      set(setForegroundAuthRecovery$, recovery);
      return recovery;
    };

    const recoverOnFocus = onDomEventFn(async () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      await recoverForeground(get(foregroundAuthRecoveryEnabled$));
    });

    document.addEventListener(
      "visibilitychange",
      onDomEventFn(async () => {
        if (document.visibilityState !== "visible") {
          abortForegroundRecovery();
          return;
        }

        const waitBeforeCatchUp = get(foregroundAuthRecoveryEnabled$);
        const recovery = recoverForeground(waitBeforeCatchUp);
        if (!waitBeforeCatchUp) {
          L.debug("tab visible, notifying catch-up subscribers immediately");
          notifyCatchUp();
        }
        await recovery;
      }),
      { signal },
    );
    window.addEventListener("focus", recoverOnFocus, { signal });
    signal.addEventListener("abort", abortForegroundRecovery, { once: true });
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
async function resumeClerkSession(
  clerk: ClerkLike,
  expectedOrgId: string | null,
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
  return Boolean(
    token &&
    (expectedOrgId === null ||
      session.lastActiveOrganizationId === expectedOrgId),
  );
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
