import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { clerk$, watchOrgSwitch$ } from "./auth.ts";
import { detach, onRef, Reason } from "./utils.ts";

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
const pollUserInvitations$ = command(async ({ set }, signal: AbortSignal) => {
  while (!signal.aborted) {
    await delay(POLL_INTERVAL_MS, { signal });
    set(reloadInvitations$, (x) => {
      return x + 1;
    });
  }
});

/**
 * Org switcher lifecycle — watches org changes and polls invitations.
 * Wire to a DOM element via `onRef`.
 */
const orgSwitcherSetup$ = command(
  async ({ set }, el: HTMLElement, signal: AbortSignal) => {
    detach(set(watchOrgSwitch$, el, signal), Reason.Entrance);
    await set(pollUserInvitations$, signal);
  },
);

export const orgSwitcherRef$ = onRef(orgSwitcherSetup$);
