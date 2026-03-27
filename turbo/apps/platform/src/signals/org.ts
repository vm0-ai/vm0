import { command, computed, state } from "ccstate";
import { zeroOrgContract, type OrgResponse } from "@vm0/core";
import { user$ } from "./auth.ts";
import { zeroClient$ } from "./api-client.ts";
import { logger } from "./log.ts";

const reloadOrg$ = state(0);

const L = logger("Org");

/**
 * Re-export for backward compatibility with mocks and consumers.
 */
export type Org = OrgResponse;

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
  const result = await client.get();

  L.debug(`Fetched /api/zero/org with status ${result.status}`);

  if (result.status === 404) {
    return undefined;
  }

  if (result.status === 200) {
    return result.body;
  }

  throw new Error(`Failed to fetch org: ${result.status}`);
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
  set(reloadOrg$, (x) => x + 1);
});
