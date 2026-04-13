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
 * Per-Clerk-instance in-flight refresh promise. Scoped to the instance (not
 * the module) so concurrent 401s against the same Clerk share one refresh,
 * but distinct instances (e.g. across tests) stay isolated.
 */
const pendingRefreshes = new WeakMap<ClerkLike, Promise<string | null>>();

/**
 * Force-refresh the Clerk session token. Returns the new token only if it
 * is non-null and differs from `staleToken`; otherwise returns `null` to
 * signal "no retry should be attempted".
 *
 * Concurrent 401s against the same Clerk instance share a single in-flight
 * refresh promise so we don't storm the Clerk FAPI.
 */
export async function fetchFreshToken(
  clerk: ClerkLike,
  staleToken: string | null,
): Promise<string | null> {
  if (!clerk.session) {
    return null;
  }
  let pending = pendingRefreshes.get(clerk);
  if (!pending) {
    const session = clerk.session;
    pending = session.getToken({ skipCache: true }).finally(() => {
      pendingRefreshes.delete(clerk);
    });
    pendingRefreshes.set(clerk, pending);
  }
  const freshToken = await pending;
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
