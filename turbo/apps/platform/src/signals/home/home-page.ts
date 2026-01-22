import { command } from "ccstate";
import { createElement } from "react";
import { HomePage } from "../../views/home/home-page.tsx";
import { updatePage$ } from "../react-router.ts";
import {
  hasScope$,
  initScope$,
  openOnboardingModal$,
  markOnboardingComplete$,
} from "../scope.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(HomePage));

    // Check if user has scope
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (!scopeExists) {
      // Show modal and start initialization simultaneously
      set(openOnboardingModal$);
      await set(initScope$, signal);
      signal.throwIfAborted();
      // Mark initialization as complete
      set(markOnboardingComplete$);
    }
  },
);
