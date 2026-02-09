"use client";

/**
 * Client-side auth hooks that work in both SaaS and self-hosted mode.
 *
 * In SaaS mode, delegates to Clerk's useUser/useClerk hooks.
 * In self-hosted mode, returns static values (always signed in, no-op signOut).
 */

import { useUser, useClerk } from "@clerk/nextjs";

const selfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === "true";

interface AuthState {
  isSignedIn: boolean;
  signOut: () => Promise<void>;
}

function useSaaSAuth(): AuthState {
  const { isSignedIn } = useUser();
  const { signOut } = useClerk();
  return {
    isSignedIn: isSignedIn ?? false,
    signOut: () => signOut().then(() => undefined),
  };
}

function useLocalAuth(): AuthState {
  return {
    isSignedIn: true,
    signOut: () => Promise.resolve(),
  };
}

export const useAuth = selfHosted ? useLocalAuth : useSaaSAuth;
