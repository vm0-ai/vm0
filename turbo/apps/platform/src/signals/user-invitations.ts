import { command, computed, state } from "ccstate";
import { clerk$ } from "./auth.ts";

const reloadInvitations$ = state(0);

/**
 * Pending organization invitations for the current user.
 *
 * Fetches from Clerk's `user.getOrganizationInvitations` API on first access
 * and whenever `refreshUserInvitations$` is called. To avoid hitting Clerk's
 * API rate limits, this is a lazy computed signal — it only re-fetches when
 * explicitly triggered via the reload state.
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
 * Trigger a re-fetch of the user invitations signal.
 */
export const refreshUserInvitations$ = command(({ set }) => {
  set(reloadInvitations$, (x) => {
    return x + 1;
  });
});
