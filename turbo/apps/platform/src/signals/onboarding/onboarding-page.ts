import { command } from "ccstate";
import { createElement } from "react";
import { OnboardingPage } from "../../views/onboarding/onboarding-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { navigateInReact$ } from "../route.ts";
import { hasScope$, initScope$ } from "../scope.ts";

/**
 * Setup command for the onboarding page.
 * Auto-creates scope if not exists, redirects to home if already has a scope.
 */
export const setupOnboardingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();

    // Check if already has scope (direct access case)
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (scopeExists) {
      set(navigateInReact$, "/");
      return;
    }

    // Show page first, then create scope
    set(updatePage$, createElement(OnboardingPage));

    // Auto-create scope
    await set(initScope$, signal);
    signal.throwIfAborted();
  },
);
