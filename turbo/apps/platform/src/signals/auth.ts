import { Clerk } from "@clerk/clerk-js";
import { command, computed, state } from "ccstate";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";
import { hasClerkAuth } from "../env.ts";

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
 * In self-hosted mode, return a mock Clerk-like object that satisfies
 * all call sites without actually loading the Clerk SDK.
 */
function createSelfHostedClerk(): Clerk {
  return {
    user: {
      id: "self-hosted-user",
      fullName: "Admin",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "admin@localhost" },
    },
    session: {
      getToken: () => Promise.resolve(null),
    },
    addListener: () => () => {},
    signOut: () => {
      location.href = "/";
    },
    redirectToSignIn: () => {},
    openUserProfile: () => {},
  } as unknown as Clerk;
}

/**
 * Clerk instance signal.
 *
 * - SaaS mode: initializes the real Clerk SDK with the publishable key.
 * - Self-hosted mode: returns a mock object (no external auth dependency).
 */
export const clerk$ = computed(async () => {
  if (!hasClerkAuth) {
    return createSelfHostedClerk();
  }

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
export const user$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  return clerk.user ?? undefined;
});
