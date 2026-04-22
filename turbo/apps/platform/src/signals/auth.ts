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
 * User signal that provides the current authenticated user from Clerk.
 * Returns undefined if no user is authenticated.
 */
const ORG_ID_KEY = "clerk-active-org-id";

function persistOrgId(orgId: string | undefined) {
  if (orgId) {
    sessionStorage.setItem(ORG_ID_KEY, orgId);
  } else {
    sessionStorage.removeItem(ORG_ID_KEY);
  }
}

/**
 * Command that monitors the active Clerk organization and reloads
 * the page when it changes. Persists the active org ID to session storage.
 */
export const watchOrgSwitch$ = command(async ({ get }, signal: AbortSignal) => {
  const clerk = await get(clerk$);
  signal.throwIfAborted();

  let prevOrgId = sessionStorage.getItem(ORG_ID_KEY) ?? undefined;
  const currentOrgId = clerk.organization?.id ?? undefined;
  prevOrgId = currentOrgId;
  persistOrgId(currentOrgId);

  // Listener stays `() => void`: Clerk's `ListenerCallback` signature
  // is not awaited, and returning a promise from it would trip
  // `typescript/no-misused-promises`. The promise chain below handles
  // both fulfillment and rejection in `.then(reload, reload)`, which
  // satisfies `typescript/no-floating-promises` and ensures the
  // reload still fires even if the token rotation rejects.
  const unsubscribe = clerk.addListener(() => {
    const newOrgId = clerk.organization?.id ?? undefined;
    if (newOrgId === prevOrgId) {
      return;
    }
    prevOrgId = newOrgId;
    persistOrgId(newOrgId);
    // Force a JWT rotation so the __session cookie carries the new
    // org_id claim before the reload — a brand-new tab opened in
    // parallel would otherwise read the stale cookie JWT (which bakes
    // org_id at mint time) and see the old org until the ~60s TTL
    // expires. Passing the same reload handler as both fulfilled and
    // rejected callbacks to `.then` guarantees the reload runs in
    // both cases: on success the fresh JWT is already in the cookie;
    // on failure the full page load will re-establish Clerk state
    // regardless. This form also satisfies
    // `typescript/no-floating-promises`, which requires a rejection
    // handler on the terminal call.
    const reload = (): void => {
      // Full page load is required because server-side data (agents,
      // jobs, secrets, etc.) is scoped to the active organization and
      // multiple signal trees depend on the org context established
      // at bootstrap time.
      location.href = "/";
    };
    clerk.session?.getToken({ skipCache: true }).then(reload, reload);
  });
  signal.addEventListener("abort", unsubscribe);
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
