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
import { detach, Reason, settle } from "./utils";

export type ClerkLike = Pick<Clerk, "session" | "redirectToSignIn">;

const AUTH_TRANSITION_REDIRECT_SUPPRESSION_MS = 30_000;

type FreshTokenResult =
  | { readonly status: "refreshed"; readonly token: string }
  | { readonly status: "unavailable" }
  | { readonly status: "offline" };

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
 * Force-refresh the Clerk session token. Clerk performs bounded transient
 * retries internally. Once those retries determine the browser is offline,
 * preserve the session and let the next API action retry after connectivity
 * returns instead of redirecting to sign-in.
 *
 * Concurrent 401s may each trigger their own refresh, but Clerk's FAPI
 * internally dedups in-flight token requests, so the extra traffic is
 * bounded and not worth adding module-level state to avoid.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  staleToken: string | null,
): Promise<FreshTokenResult> {
  if (!clerk.session) {
    return { status: "unavailable" };
  }
  const tokenResult = await settle(clerk.session.getToken({ skipCache: true }));
  if (!tokenResult.ok) {
    const { error } = tokenResult;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "clerk_offline"
    ) {
      return { status: "offline" };
    }
    throw error;
  }
  if (!tokenResult.value || tokenResult.value === staleToken) {
    return { status: "unavailable" };
  }
  return { status: "refreshed", token: tokenResult.value };
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
