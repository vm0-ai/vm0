import { command, computed, state } from "ccstate";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";

const reload$ = state(0);

/**
 * Resolve the web app origin from the current app origin.
 * Replaces "platform" or "app" with "www" in the hostname so sign-in/sign-out
 * redirects land on the web app where auth pages live.
 */
export function resolveWebOrigin(): string {
  const origin = location.origin;
  if (!origin || origin === "null") {
    return "";
  }
  const url = new URL(origin);
  url.hostname = url.hostname.replace(/(^|-)(platform|app)\./, "$1www.");
  return url.origin;
}

/**
 * Clerk instance signal.
 *
 * Initializes the real Clerk SDK with the publishable key.
 */
export const clerk$ = computed(async () => {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
    | string
    | undefined;

  if (!publishableKey) {
    throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY environment variable");
  }

  // Dynamic import: @clerk/clerk-js is a 2.8MB webpack monolith (53%
  // Web3/Solana/Coinbase code we don't use) that cannot be tree-shaken.
  // Moving it to a separate async chunk avoids blocking initial JS parsing.
  const { Clerk } = await import("@clerk/clerk-js");

  const webOrigin = resolveWebOrigin();
  const clerkInstance = new Clerk(publishableKey);
  await clerkInstance.load({
    signInUrl: `${webOrigin}/sign-in`,
    signUpUrl: `${webOrigin}/sign-up`,
    afterSignOutUrl: `${webOrigin}/sign-in`,
  });
  return clerkInstance;
});

/**
 * Command to setup Clerk authentication listeners.
 * This command initializes the Clerk instance and sets up a listener
 * for authentication state changes.
 */
export const setupClerk$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    // Set initial Sentry user context
    if (clerk.user) {
      setSentryUser(clerk.user.id);
    }

    // Track the user ID so we only trigger a reload on actual auth state
    // changes (sign-in / sign-out), not on token refreshes which fire the
    // Clerk listener but don't change the user.
    let prevUserId = clerk.user?.id ?? null;
    const unsubscribe = clerk.addListener(() => {
      // Update Sentry user context on auth state change
      if (clerk.user) {
        setSentryUser(clerk.user.id);
      } else {
        clearSentryUser();
      }
      const currentUserId = clerk.user?.id ?? null;
      if (currentUserId !== prevUserId) {
        prevUserId = currentUserId;
        set(reload$, (x) => {
          return x + 1;
        });
      }
    });
    signal.addEventListener("abort", unsubscribe);
  },
);

/**
 * Daemon that listens for Clerk state changes and reloads the page on any
 * active-organization switch. This runs in every tab on every origin, so:
 *
 * - The tab that initiated the switch (via `clerk.setActive`) reloads as
 *   soon as Clerk's listener fires.
 * - Sibling tabs reload too — Clerk v5 broadcasts `sessionUpdated` via
 *   its internal BroadcastChannel, so their Clerk instances pick up the
 *   change and fire listeners within milliseconds.
 *
 * Before reloading we force Clerk to mint a fresh session JWT with
 * `skipCache: true`. The session cookie is shared across *.vm0.ai, so
 * without this, the reload (or any in-flight request to www.vm0.ai) could
 * land with a stale JWT whose orgId still reflects the previous org.
 *
 * Runs until its signal aborts — kick off via `detach()` from the views
 * layer since it never resolves on its own.
 */
export const watchOrgSwitch$ = command(async ({ get }, signal: AbortSignal) => {
  const clerk = await get(clerk$);
  signal.throwIfAborted();

  let prevOrgId = clerk.organization?.id ?? undefined;

  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => {};
      const onAbort = () => {
        unsubscribe();
        resolve();
      };
      // Clerk's addListener fires the callback synchronously once on
      // registration with the current state — skip that initial call, we only
      // care about subsequent state changes.
      let initialized = false;
      unsubscribe = clerk.addListener(() => {
        if (!initialized) {
          initialized = true;
          return;
        }
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve();
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) {
      return;
    }

    const newOrgId = clerk.organization?.id ?? undefined;
    if (newOrgId === prevOrgId) {
      continue;
    }
    prevOrgId = newOrgId;

    await clerk.session?.getToken({ skipCache: true }).catch(() => {
      return null;
    });
    signal.throwIfAborted();
    location.href = "/";
    return;
  }
});

export const user$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  return clerk.user ?? undefined;
});

/**
 * Determines whether the current user needs to select an organization
 * before entering the platform.
 *
 * Returns true when ALL of:
 * - No active organization is set in the Clerk session
 * - AND at least one of:
 *   - User belongs to more than 1 organization
 *   - User has pending organization invitations
 *
 */
export const needsOrgSelection$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return false;
  }

  // If an active organization is already set, no selection needed
  if (clerk.organization) {
    return false;
  }

  // No active organization — user must select or create one
  return true;
});
