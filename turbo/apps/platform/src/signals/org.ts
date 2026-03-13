import { computed, state } from "ccstate";
import { user$ } from "./auth.ts";
import { fetch$ } from "./fetch.ts";
import { logger } from "./log.ts";

const L = logger("Org");

/**
 * Reload trigger for org signals.
 * Increment to force recomputation of org$.
 */
const internalReloadOrg$ = state(0);

/**
 * Org response type from API
 */
export interface Org {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Current user's default org.
 * Returns undefined if user has no org or is not authenticated.
 */
export const org$ = computed(async (get) => {
  get(internalReloadOrg$); // Subscribe to reload trigger
  const user = await get(user$);
  if (!user) {
    return undefined;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/scope");

  L.debug(`Fetched /api/scope with status ${response.status}`);
  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch org: ${response.status}`);
  }

  return (await response.json()) as Org;
});

/**
 * Whether the current user has an org.
 */
export const hasOrg$ = computed(async (get) => {
  const org = await get(org$);
  return org !== undefined;
});
