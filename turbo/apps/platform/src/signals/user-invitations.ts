import { command, computed, state } from "ccstate";
import { clerk$ } from "./auth.ts";
import { setLoop } from "./utils.ts";

const POLL_INTERVAL_MS = 30_000;

const reloadInvitations$ = state(0);

/**
 * Pending organization invitations for the current user.
 * Re-fetches when `refreshUserInvitations$` is called or the poll loop ticks.
 */
export const userInvitations$ = computed(async (get) => {
  get(reloadInvitations$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return [];
  }

  const result = await user.getOrganizationInvitations({ status: "pending" });
  return result.data;
});

/**
 * Trigger an immediate re-fetch of the user invitations signal.
 */
export const refreshUserInvitations$ = command(({ set }) => {
  set(reloadInvitations$, (x) => {
    return x + 1;
  });
});

/**
 * Poll invitations on a fixed interval until aborted.
 */
export const pollUserInvitations$ = command(
  async ({ set }, signal: AbortSignal) => {
    await setLoop(
      () => {
        set(reloadInvitations$, (x) => {
          return x + 1;
        });
        return true;
      },
      POLL_INTERVAL_MS,
      signal,
    );
  },
);
