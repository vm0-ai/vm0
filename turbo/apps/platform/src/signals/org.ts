import { command, computed, state } from "ccstate";
import { zeroOrgContract } from "@vm0/core";
import { user$ } from "./auth.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";

const reloadOrg$ = state(0);

/**
 * Current user's default org.
 * Returns undefined if user has no org or is not authenticated.
 */
export const org$ = computed(async (get) => {
  get(reloadOrg$);
  const user = await get(user$);
  if (!user) {
    return undefined;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroOrgContract);
  // 404 is a valid response: a newly-signed-up user has no org yet.
  // Pass { toast: false } so the signal surfaces the absent-org state
  // through its value (undefined) rather than firing an error toast.
  const result = await accept(client.get(), [200, 404], { toast: false });

  if (result.status === 404) {
    return undefined;
  }

  return result.body;
});

/**
 * Current user's role in their org.
 * Defaults to "member" if org is not available.
 */
const orgRole$ = computed(async (get) => {
  const org = await get(org$);
  return org?.role ?? "member";
});

/**
 * Whether the current user is an admin of their org.
 */
export const isOrgAdmin$ = computed(async (get) => {
  const role = await get(orgRole$);
  return role === "admin";
});

/**
 * Trigger a re-fetch of the org signal.
 */
export const refreshOrg$ = command(({ set }) => {
  set(reloadOrg$, (x) => {
    return x + 1;
  });
});
