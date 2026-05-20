import { createElement } from "react";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ZeroDesktopComputerUsePage } from "../../views/zero-page/desktop-computer-use-page.tsx";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import { setupDesktopComputerUseBridge$ } from "./desktop-computer-use-signals.ts";

export const setupDesktopComputerUsePage$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const enabled = get(featureSwitch$)[FeatureSwitchKey.ComputerUse];
    const api = window.vm0DesktopComputerUse;
    if (!enabled || !api) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(ZeroDesktopComputerUsePage), "sidebar");
    set(setupDesktopComputerUseBridge$, signal);
  },
);
