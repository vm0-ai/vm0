/**
 * Auth retry helpers shared by `fetch$` (signals/fetch.ts) and
 * `zeroClient$` (signals/api-client.ts).
 *
 * On a 401 response we force-refresh the Clerk JWT and replay the request
 * once before falling back to `clerk.redirectToSignIn()`. This covers the
 * common PWA case where `session.getToken()` returned a cached token that
 * expired between fetch and server-side validation (see issue #8883).
 */
import { command, computed, state } from "ccstate";
import type { Clerk } from "@clerk/clerk-js";
import { now } from "../lib/time.ts";
import { detach, Reason } from "./utils";

export type ClerkLike = Pick<Clerk, "session" | "redirectToSignIn">;

const AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS = 30_000;

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
 * Force-refresh the Clerk session token. Returns the new token only if it
 * is non-null and differs from `staleToken`; otherwise returns `null` to
 * signal "no retry should be attempted".
 *
 * Concurrent 401s may each trigger their own refresh, but Clerk's FAPI
 * internally dedups in-flight token requests, so the extra traffic is
 * bounded and not worth adding module-level state to avoid.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  staleToken: string | null,
): Promise<string | null> {
  if (!clerk.session) {
    return null;
  }
  const freshToken = await clerk.session.getToken({ skipCache: true });
  if (!freshToken || freshToken === staleToken) {
    return null;
  }
  return freshToken;
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
