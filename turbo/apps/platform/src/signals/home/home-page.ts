import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/core";
import { HomePage } from "../../views/home/home-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { needsOnboarding$, startOnboarding$ } from "../onboarding.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { navigateInReact$ } from "../route.ts";

export const setupHomePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();

    if (features[FeatureSwitchKey.Zero]) {
      set(navigateInReact$, "/zero");
      return;
    }

    set(updatePage$, createElement(HomePage));

    const needsOnboarding = await get(needsOnboarding$);
    signal.throwIfAborted();

    if (needsOnboarding) {
      set(startOnboarding$);
    }
  },
);
