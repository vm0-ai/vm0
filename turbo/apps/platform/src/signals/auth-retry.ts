/**
 * Auth retry helpers shared by `fetch$` (signals/fetch.ts) and
 * `zeroClient$` (signals/api-client.ts).
 *
 * On a 401 response we force-refresh the Clerk JWT and replay the request.
 * Network failures during either recovery step retry with fibonacci backoff.
 * Only an explicit 401 after recovery falls back to
 * `clerk.redirectToSignIn()`.
 */
import { command, computed, state } from "ccstate";
import type { Clerk } from "@clerk/clerk-js";
import { isNetworkRequestError } from "../lib/network-error.ts";
import { now } from "../lib/time.ts";
import { detach, Reason, retryWithFibonacciBackoff } from "./utils";

export type ClerkLike = Pick<Clerk, "session" | "redirectToSignIn">;

const AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS = 30_000;

type FreshTokenResult =
  | { readonly status: "refreshed"; readonly token: string }
  | { readonly status: "unavailable" };

const unauthorizedRedirectSuppressionUntilState$ = state(0);

export const unauthorizedRedirectSuppressionUntil$ = computed((get) => {
  return get(unauthorizedRedirectSuppressionUntilState$);
});

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

/**
 * Force-refresh the Clerk session token. Network failures retry until the
 * request's owning signal aborts, so a temporarily offline browser does not
 * turn into a sign-in redirect.
 *
 * Concurrent 401s may each trigger their own refresh, but Clerk's FAPI
 * internally dedups in-flight token requests, so the extra traffic is
 * bounded and not worth adding module-level state to avoid.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<FreshTokenResult> {
  signal.throwIfAborted();
  const session = clerk.session;
  if (!session) {
    return { status: "unavailable" };
  }
  const token = await retryAuthRecoveryOperation(() => {
    return session.getToken({ skipCache: true });
  }, signal);
  if (!token) {
    return { status: "unavailable" };
  }
  return { status: "refreshed", token };
}

function isClerkOfflineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "clerk_offline"
  );
}

function isAuthRecoveryNetworkError(error: unknown): boolean {
  return isClerkOfflineError(error) || isNetworkRequestError(error);
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
  if (isUnauthorizedRedirectSuppressed(suppressionUntil)) {
    return;
  }
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line ccstate/no-detach-in-signals
  detach(clerk.redirectToSignIn(), Reason.Entrance);
}
