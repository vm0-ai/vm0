import { command } from "ccstate";
import { clerk$, resolveAppAuthUrl, resolveWebOrigin } from "../auth.ts";
import { searchParams$ } from "../route.ts";
import {
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
} from "./zero-onboarding.ts";

const ONBOARDING_PATH = "/onboarding/2afcf6";

function onboardingUrl(searchParams: URLSearchParams): string {
  // Onboarding lives on the www sibling of the current host; the onboarding
  // surface derives its app/api URLs from its own host the same way, so no
  // environment configuration or domain hint is needed.
  const url = new URL(ONBOARDING_PATH, resolveWebOrigin());
  const search = searchParams.toString();
  if (search) {
    url.search = search;
  }
  return url.toString();
}

const redirectToOnboarding$ = command(
  async (
    { get },
    searchParams: URLSearchParams | undefined,
    signal: AbortSignal,
  ) => {
    const url = onboardingUrl(searchParams ?? get(searchParams$));
    // buildUrlWithAuth carries the session across origins: on Clerk
    // development instances the session lives in a per-origin dev browser
    // JWT, so a bare cross-origin navigation to the www onboarding surface
    // would land signed-out and bounce back to /sign-in. On production
    // instances it returns the URL unchanged.
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    window.location.href = clerk.buildUrlWithAuth(url);
  },
);

export const redirectToConfiguredOnboarding$ = command(
  async (
    { set },
    searchParams: URLSearchParams | undefined,
    signal: AbortSignal,
  ) => {
    await set(redirectToOnboarding$, searchParams, signal);
  },
);

export const setupOnboardingRedirectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    await set(redirectToConfiguredOnboarding$, undefined, signal);
  },
);

/**
 * Check whether the current user needs onboarding and redirect if so.
 * Returns `true` when a redirect was triggered (caller should bail out),
 * `false` otherwise.
 *
 * Onboarding is purely admin workspace setup — only an admin whose org has no
 * default agent yet is sent through onboarding. Non-admins never go through it.
 *
 * When the backend cannot resolve the current org (e.g. it was deleted) but the
 * user still belongs to other orgs, redirect to the web app's
 * choose-organization page instead of `/onboarding` so they can pick a valid org.
 */
export const onboardGuard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();

    if (!needsOnboarding) {
      return false;
    }

    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
    if (!status.hasOrg) {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const memberships = clerk.user?.organizationMemberships ?? [];
      if (memberships.length > 0) {
        window.location.href = resolveAppAuthUrl(
          "/sign-in/tasks/choose-organization",
        );
        return true;
      }
    }

    await set(redirectToConfiguredOnboarding$, undefined, signal);
    return true;
  },
);
