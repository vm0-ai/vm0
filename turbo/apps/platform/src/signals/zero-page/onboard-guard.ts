import { command } from "ccstate";
import { navigateTo$ } from "../route.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "./zero-onboarding.ts";

/**
 * Check whether the current user needs onboarding and redirect if so.
 * Returns `true` when a redirect was triggered (caller should bail out),
 * `false` otherwise.
 */
export const onboardGuard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();
    if (needsOnboarding || needsMemberOnboarding) {
      set(navigateTo$, "/onboarding", { replace: true });
      return true;
    }
    return false;
  },
);
