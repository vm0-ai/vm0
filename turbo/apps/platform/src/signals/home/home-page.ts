import { command } from "ccstate";
import { createElement } from "react";
import { HomePage } from "../../views/home/home-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { hasScope$ } from "../scope.ts";
import { startOnboarding$ } from "../onboarding.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(HomePage));

    // Check if user has scope
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (!scopeExists) {
      // Start onboarding flow - shows modal and initializes scope
      await set(startOnboarding$, signal);
    }
  },
);
