import { command } from "ccstate";
import { updatePage$ } from "../react-router";
import { createElement } from "react";
import { updateDocumentTitle$ } from "../document-title";
import { MissionControlPage } from "../../views/mission-control-page/mission-control-page";
import { hideAppSkeleton$ } from "../app-skeleton";
import { onboardGuard$ } from "../zero-page/onboard-guard";
import {
  setupMissionControlKeyboard$,
  setupMissionControlLoop$,
} from "./mission-control.ts";

export const setupMissionControlPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(MissionControlPage), "sidebar");

    set(updateDocumentTitle$, "Mission Control");
    set(setupMissionControlKeyboard$, signal);

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(setupMissionControlLoop$, signal);
  },
);
