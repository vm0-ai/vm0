import { command } from "ccstate";
import { clerk$, resolveWebOrigin } from "../auth.ts";
import { detachedNavigateTo$ } from "../route.ts";
import {
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "./zero-onboarding.ts";

/**
 * Check whether the current user needs onboarding and redirect if so.
 * Returns `true` when a redirect was triggered (caller should bail out),
 * `false` otherwise.
 *
 * When the backend cannot resolve the current org (e.g. it was deleted) but the
 * user still belongs to other orgs, redirect to the web app's
 * choose-organization page instead of `/onboarding` so they can pick a valid org.
 */
export const onboardGuard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();

    if (!needsOnboarding && !needsMemberOnboarding) {
      return false;
    }

    // If the backend couldn't resolve the org (deleted / stale JWT) but the
    // user still has memberships in other orgs, send them to org selection
    // instead of onboarding.
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
    if (!status.hasOrg) {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const memberships = clerk.user?.organizationMemberships ?? [];
      if (memberships.length > 0) {
        window.location.href = `${resolveWebOrigin()}/sign-in/tasks/choose-organization`;
        return true;
      }
    }

    set(detachedNavigateTo$, "/onboarding", { replace: true });
    return true;
  },
);
