import { Clerk } from "@clerk/clerk-js";
import { command, computed, state } from "ccstate";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";

const reload$ = state(0);

/**
 * Resolve the web app origin from the current platform origin.
 * Replaces "platform" with "www" in the hostname so sign-in/sign-out
 * redirects land on the web app where auth pages live.
 */
function resolveWebOrigin(): string {
  const origin = location.origin;
  if (!origin || origin === "null") {
    return "";
  }
  const url = new URL(origin);
  url.hostname = url.hostname.replace("platform", "www");
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

    const unsubscribe = clerk.addListener(() => {
      // Update Sentry user context on auth state change
      if (clerk.user) {
        setSentryUser(clerk.user.id);
      } else {
        clearSentryUser();
      }
      set(reload$, (x) => x + 1);
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
export const watchOrgSwitch$ = command(
  async ({ get }, _el: HTMLElement, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    let prevOrgId = sessionStorage.getItem(ORG_ID_KEY) ?? undefined;
    const currentOrgId = clerk.organization?.id ?? undefined;
    prevOrgId = currentOrgId;
    persistOrgId(currentOrgId);

    const unsubscribe = clerk.addListener(() => {
      const newOrgId = clerk.organization?.id ?? undefined;
      if (newOrgId !== prevOrgId) {
        prevOrgId = newOrgId;
        persistOrgId(newOrgId);
        // Full page reload is required because server-side data (agents, jobs,
        // secrets, etc.) is scoped to the active organization. A lighter state
        // refresh is not feasible since multiple signal trees depend on the
        // org context established at bootstrap time.
        location.reload();
      }
    });
    signal.addEventListener("abort", unsubscribe);
  },
);

export const user$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  return clerk.user ?? undefined;
});
