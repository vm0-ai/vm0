import { command } from "ccstate";
import { createElement } from "react";
import { HomePage } from "../../views/home/home-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { needsOnboarding$, startOnboarding$ } from "../onboarding.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(HomePage));

    const needsOnboarding = await get(needsOnboarding$);
    signal.throwIfAborted();

    if (needsOnboarding) {
      await set(startOnboarding$, signal);
    }
  },
);
