import { command, computed, state } from "ccstate";
import { user$ } from "./auth.ts";
import { fetch$ } from "./fetch.ts";

/**
 * Internal state for onboarding modal visibility.
 */
const internalShowOnboardingModal$ = state(false);

/**
 * Internal state for scope initialization completion.
 */
const internalOnboardingComplete$ = state(false);

/**
 * Whether the onboarding modal is currently shown.
 */
export const showOnboardingModal$ = computed((get) =>
  get(internalShowOnboardingModal$),
);

/**
 * Whether scope initialization has completed (for modal close button).
 */
export const onboardingComplete$ = computed((get) =>
  get(internalOnboardingComplete$),
);

/**
 * Show the onboarding modal.
 */
export const openOnboardingModal$ = command(({ set }) => {
  set(internalShowOnboardingModal$, true);
});

/**
 * Mark onboarding as complete.
 */
export const markOnboardingComplete$ = command(({ set }) => {
  set(internalOnboardingComplete$, true);
});

/**
 * Reload trigger for scope signals.
 * Increment to force recomputation of scope$.
 */
const internalReloadScope$ = state(0);

/**
 * Scope response type from API
 */
export interface Scope {
  id: string;
  slug: string;
  type: "personal" | "organization" | "system";
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Current user's scope.
 * Returns undefined if user has no scope or is not authenticated.
 * Internal computed, used by hasScope$.
 */
const scope$ = computed(async (get) => {
  get(internalReloadScope$); // Subscribe to reload trigger
  const user = await get(user$);
  if (!user) {
    return undefined;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/scope");

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch scope: ${response.status}`);
  }

  return (await response.json()) as Scope;
});

/**
 * Whether the current user has a scope.
 */
export const hasScope$ = computed(async (get) => {
  const scope = await get(scope$);
  return scope !== undefined;
});

/**
 * Generate a deterministic scope slug from user ID.
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
  return `${hashHex.slice(0, 8)}`;
}

/**
 * Create scope for current user with auto-generated slug.
 * Triggers reload after successful creation.
 */
export const initScope$ = command(async ({ get, set }, signal: AbortSignal) => {
  const user = await get(user$);
  signal.throwIfAborted();

  if (!user) {
    throw new Error("User must be authenticated to create scope");
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
    throw new Error(`Failed to create scope: ${response.status}`);
  }

  set(internalReloadScope$, (x) => x + 1);
});

/**
 * Close the onboarding modal and reset state.
 */
export const closeOnboardingModal$ = command(({ set }) => {
  set(internalShowOnboardingModal$, false);
  set(internalOnboardingComplete$, false);
});
