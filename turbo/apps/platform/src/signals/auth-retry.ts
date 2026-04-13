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

let pendingRefresh: Promise<string | null> | null = null;

/**
 * Force-refresh the Clerk session token. Returns the new token only if it
 * is non-null and differs from `staleToken`; otherwise returns `null` to
 * signal "no retry should be attempted".
 *
 * Concurrent 401s share a single in-flight refresh promise so we don't
 * storm the Clerk FAPI.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  staleToken: string | null,
): Promise<string | null> {
  if (!clerk.session) {
    return null;
  }
  if (!pendingRefresh) {
    const session = clerk.session;
    pendingRefresh = session.getToken({ skipCache: true }).finally(() => {
      pendingRefresh = null;
    });
  }
  const freshToken = await pendingRefresh;
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
