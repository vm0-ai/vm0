import { command, computed, state } from "ccstate";

import { clerk$ } from "../auth.ts";
import { replacePathSilently$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { settle, withCleanup } from "../utils.ts";
import type { AuthV2RouteMode } from "./navigation.ts";

interface AuthInvitation {
  readonly mode: AuthV2RouteMode;
  readonly ticket: string;
}

const internalInvitation$ = state<AuthInvitation | null>(null);
export const authV2Invitation$ = computed((get) => {
  return get(internalInvitation$);
});

// Tickets are credentials. Keep them in memory only and remove them before
// bootstrap analytics or unauthenticated-route logging can observe the URL.
export const captureAuthV2Invitation$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  const ticket = params.get("__clerk_ticket");
  const status = params.get("__clerk_status");
  if (
    !ticket ||
    (status !== "sign_in" && status !== "sign_up" && status !== null)
  ) {
    return;
  }
  const mode =
    status === "sign_in" ||
    (status === null && location.pathname.startsWith(ROUTES.signIn))
      ? "sign-in"
      : "sign-up";
  const destination = new URL(location.href);
  destination.searchParams.delete("__clerk_ticket");
  destination.searchParams.delete("__clerk_status");
  params.delete("__clerk_ticket");
  params.delete("__clerk_status");
  if (
    !location.pathname.startsWith(ROUTES.signIn) &&
    !location.pathname.startsWith(ROUTES.signUp) &&
    !params.has("redirect_url")
  ) {
    params.set("redirect_url", destination.toString());
  }
  set(internalInvitation$, { mode, ticket });
  set(
    replacePathSilently$,
    mode === "sign-in" ? ROUTES.signIn : ROUTES.signUp,
    undefined,
    params,
    location.hash,
  );
});

const internalInvitationError$ = state(false);
export const authV2InvitationError$ = computed((get) => {
  return get(internalInvitationError$);
});
const redeemInFlight$ = state<Promise<boolean> | null>(null);
const redeem$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const invitation = get(authV2Invitation$);
    if (!invitation) {
      return true;
    }
    set(internalInvitationError$, false);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.client) {
      throw new Error(
        "Loaded Clerk instance did not provide a client resource",
      );
    }
    const resource =
      invitation.mode === "sign-in" ? clerk.client.signIn : clerk.client.signUp;
    const result = await settle<unknown>(
      resource.create({ strategy: "ticket", ticket: invitation.ticket }),
      signal,
    );
    if (!result.ok) {
      set(internalInvitationError$, true);
      return false;
    }
    set(internalInvitation$, null);
    return true;
  },
);
export const redeemAuthV2Invitation$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const current = get(redeemInFlight$);
    if (current) {
      const result = await current;
      signal.throwIfAborted();
      return result;
    }
    const request = withCleanup(set(redeem$, signal), () => {
      return set(redeemInFlight$, null);
    });
    set(redeemInFlight$, request);
    return await request;
  },
);
