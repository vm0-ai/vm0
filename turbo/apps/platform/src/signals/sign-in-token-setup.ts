import { command } from "ccstate";
import {
  buildSignInRedirectUrl,
  clerk$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveSatelliteAuthRouteRedirectUrl,
} from "./auth.ts";
import { searchParams$, detachedNavigateTo$ } from "./route.ts";
import { logger } from "./log.ts";

const L = logger("SignInToken");

/**
 * Setup command for /sign-in-token route.
 *
 * Accepts a Clerk sign-in token via `?token=...` query parameter,
 * authenticates the user on the primary platform domain, and redirects to the
 * validated completion URL.
 *
 * This route has no auth guard — the user is not yet authenticated.
 */
export const setupSignInTokenPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const satelliteAuthRedirectUrl =
      resolveSatelliteAuthRouteRedirectUrl("sign-in");
    if (satelliteAuthRedirectUrl) {
      location.replace(satelliteAuthRedirectUrl);
      return;
    }

    const completionRedirectUrl = buildSignInRedirectUrl(
      location.search,
      getAllowedAuthRedirectOriginsForCurrentPage(),
      location.hash,
    );
    const params = get(searchParams$);
    const token = params.get("token");

    if (!token) {
      L.error("Missing token parameter");
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.client) {
      L.error("Clerk client not available");
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    const result = await clerk.client.signIn.create({
      strategy: "ticket",
      ticket: token,
    });
    signal.throwIfAborted();

    if (result.status !== "complete" || !result.createdSessionId) {
      L.error("Unexpected sign-in status:", result.status);
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    await clerk.setActive({
      session: result.createdSessionId,
      navigate: ({ session, decorateUrl }) => {
        const destination = session.currentTask
          ? resolveAppAuthUrl(`/sign-in/tasks/${session.currentTask.key}`, {
              redirectUrl: completionRedirectUrl,
            })
          : completionRedirectUrl;
        window.location.href = decorateUrl(destination);
      },
    });
    signal.throwIfAborted();

    L.debug("Token sign-in complete");
  },
);
