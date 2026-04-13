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
import { logger } from "./log.ts";

const L = logger("AuthRetry");

type ClerkLike = Pick<Clerk, "session" | "redirectToSignIn">;

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
 * the page away so the returned promise may never settle — callers must not
 * await it, and the final 401 response still needs to be returned to them.
 */
export function handleUnauthorizedRedirect(clerk: ClerkLike): void {
  const redirectResult = clerk.redirectToSignIn();
  if (redirectResult instanceof Promise) {
    redirectResult.catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      L.error("Sign-in redirect failed", error);
    });
  }
}
