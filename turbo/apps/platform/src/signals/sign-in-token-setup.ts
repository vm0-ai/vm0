import { command } from "ccstate";
import { clerk$ } from "./auth.ts";
import { searchParams$, navigateTo$ } from "./route.ts";
import { logger } from "./log.ts";

const L = logger("SignInToken");

/**
 * Setup command for /sign-in-token route.
 *
 * Accepts a Clerk sign-in token via `?token=...` query parameter,
 * authenticates the user on the platform domain, and redirects to /.
 *
 * This route has no auth guard — the user is not yet authenticated.
 */
export const setupSignInTokenPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const token = params.get("token");

    if (!token) {
      L.error("Missing token parameter");
      set(navigateTo$, "/", { replace: true });
      return;
    }

    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.client) {
      L.error("Clerk client not available");
      set(navigateTo$, "/", { replace: true });
      return;
    }

    const result = await clerk.client.signIn.create({
      strategy: "ticket",
      ticket: token,
    });
    signal.throwIfAborted();

    if (result.status !== "complete" || !result.createdSessionId) {
      L.error("Unexpected sign-in status:", result.status);
      set(navigateTo$, "/", { replace: true });
      return;
    }

    await clerk.setActive({ session: result.createdSessionId });
    signal.throwIfAborted();

    L.debug("Token sign-in complete, redirecting to /");
    set(navigateTo$, "/", { replace: true });
  },
);
