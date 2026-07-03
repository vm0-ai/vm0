import { command } from "ccstate";
import { clerk$, resolveAppAuthUrl, resolveWebOrigin } from "../auth.ts";
import { searchParams$ } from "../route.ts";
import {
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
} from "./zero-onboarding.ts";

const ONBOARDING_PATH = "/onboarding/491858";

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
  ({ get }, searchParams?: URLSearchParams) => {
    window.location.href = onboardingUrl(searchParams ?? get(searchParams$));
  },
);

export const redirectToConfiguredOnboarding$ = command(
  ({ set }, searchParams?: URLSearchParams) => {
    set(redirectToOnboarding$, searchParams);
  },
);

export const setupOnboardingRedirectPage$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(redirectToConfiguredOnboarding$);
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

    set(redirectToConfiguredOnboarding$);
    return true;
  },
);
