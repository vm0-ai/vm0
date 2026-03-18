import { computed } from "ccstate";
import { user$ } from "./auth.ts";
import { fetch$ } from "./fetch.ts";
import { logger } from "./log.ts";

const L = logger("Org");

/**
 * Org response type from API
 */
export interface Org {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  role?: "admin" | "member";
}

/**
 * Current user's default org.
 * Returns undefined if user has no org or is not authenticated.
 */
export const org$ = computed(async (get) => {
  const user = await get(user$);
  if (!user) {
    return undefined;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/org");

  L.debug(`Fetched /api/org with status ${response.status}`);
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

/**
 * Current user's role in their org.
 * Defaults to "member" if org is not available.
 */
export const orgRole$ = computed(async (get) => {
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
