import { command } from "ccstate";
import { clerk$, resolveWebOrigin } from "../auth.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  onboardingEagerInitialized$,
  zeroOnboardingStatus$,
  zeroNeedsOnboarding$,
} from "./zero-onboarding.ts";

const FORWARDED_ONBOARDING_PARAMS = ["prompt", "connector"] as const;

/**
 * Check whether the current user needs onboarding and redirect if so.
 * Returns `true` when a redirect was triggered (caller should bail out),
 * `false` otherwise.
 *
 * Onboarding is purely admin workspace setup — only an admin whose org has no
 * default agent yet is sent to `/onboarding`. Non-admins never go through it.
 *
 * When the backend cannot resolve the current org (e.g. it was deleted) but the
 * user still belongs to other orgs, redirect to the web app's
 * choose-organization page instead of `/onboarding` so they can pick a valid org.
 */
export const onboardGuard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    // Admin has already provisioned the workspace via eager init this
    // session; the server may not have surfaced the new state in the cached
    // status yet, but locally we know onboarding is done. Don't redirect
    // back to /onboarding when they navigate elsewhere (e.g. continue-in-web).
    if (get(onboardingEagerInitialized$)) {
      return false;
    }

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
        window.location.href = `${resolveWebOrigin()}/sign-in/tasks/choose-organization`;
        return true;
      }
    }

    // Forward `?prompt=` and `?connector=` from the entry URL so the
    // onboarding page can pre-select connectors and the post-onboarding
    // navigation can pre-fill the chat composer.
    const incoming = get(searchParams$);
    const forwarded = new URLSearchParams();
    for (const key of FORWARDED_ONBOARDING_PARAMS) {
      const value = incoming.get(key);
      if (value !== null) {
        forwarded.set(key, value);
      }
    }
    set(detachedNavigateTo$, "/onboarding", {
      replace: true,
      searchParams: forwarded.toString().length > 0 ? forwarded : undefined,
    });
    return true;
  },
);
