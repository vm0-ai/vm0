import { command } from "ccstate";
import { clerk$, resolveAppAuthUrl } from "../auth.ts";
import { searchParams$ } from "../route.ts";
import {
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
} from "./zero-onboarding.ts";

const ONBOARDING_PATH = "/onboarding/2afcf6";

function onboardingUrl(searchParams: URLSearchParams): string {
  const configuredUrl = import.meta.env.VITE_ONBOARDING_URL as
    | string
    | undefined;
  const configuredDomain = import.meta.env.VITE_ONBOARDING_DOMAIN as
    | string
    | undefined;
  if (!configuredUrl) {
    throw new Error("Missing VITE_ONBOARDING_URL environment variable");
  }

  const url = new URL(ONBOARDING_PATH, configuredUrl);
  const search = searchParams.toString();
  if (search) {
    url.search = search;
  }
  if (configuredDomain) {
    url.searchParams.set("domain", configuredDomain);
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
