/**
 * Auth retry helpers shared by `fetch$` (signals/fetch.ts) and
 * `zeroClient$` (signals/api-client.ts).
 *
 * On a 401 response we force-refresh the Clerk JWT and replay the request
 * once before falling back to `clerk.redirectToSignIn()`. This covers the
 * common PWA case where `session.getToken()` returned a cached token that
 * expired between fetch and server-side validation (see issue #8883).
 */
import type { Clerk } from "@clerk/clerk-js";

export type ClerkLike = Pick<Clerk, "session" | "redirectToSignIn">;

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

/**
 * Fire-and-forget redirect to Clerk's hosted sign-in. The redirect navigates
 * the page away, so the returned promise may never settle and the final 401
 * response should still be returned to callers before awaiting this.
 */
export async function handleUnauthorizedRedirect(clerk: ClerkLike): Promise<void> {
  await clerk.redirectToSignIn();
}
