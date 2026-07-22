import { command } from "ccstate";
import { clerk$, resolveAppAuthUrl } from "../auth.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
} from "./zero-onboarding.ts";

export const redirectToConfiguredOnboarding$ = command(
  (
    { get, set },
    searchParams: URLSearchParams | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.onboarding, {
      searchParams: new URLSearchParams(searchParams ?? get(searchParams$)),
      replace: true,
    });
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
 * user still belongs to other orgs, redirect to the app's
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
