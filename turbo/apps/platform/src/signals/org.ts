import { command, computed, state } from "ccstate";
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

/**
 * Generate a deterministic org slug from user ID.
 * Uses SubtleCrypto (browser-compatible) to hash the user ID.
 */
async function generateDefaultSlug(userId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `user-${hashHex.slice(0, 8)}`;
}

/**
 * Create org for current user with auto-generated slug.
 * Triggers reload after successful creation.
 */
export const initOrg$ = command(async ({ get, set }, signal: AbortSignal) => {
  const user = await get(user$);
  signal.throwIfAborted();

  if (!user) {
    throw new Error("User must be authenticated to create org");
  }

  const slug = await generateDefaultSlug(user.id);
  signal.throwIfAborted();

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/scope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  signal.throwIfAborted();

  if (!response.ok) {
    throw new Error(`Failed to create org: ${response.status}`);
  }

  set(internalReloadOrg$, (x) => x + 1);
});
