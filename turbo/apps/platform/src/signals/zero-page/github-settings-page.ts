import { command } from "ccstate";
import { createElement } from "react";
import { ZeroGithubSettingsPage } from "../../views/zero-page/zero-github-settings-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { watchGithubIntegration$ } from "./zero-github.ts";
import { detach, Reason } from "../utils.ts";

export const setupGithubSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroGithubSettingsPage), "sidebar");
    set(updateDocumentTitle$, "GitHub");

    // confirmed by ethan@vm0.ai
    // eslint-disable-next-line ccstate/no-detach-in-signals -- route-scoped realtime subscription runs until the /settings/github route signal aborts
    detach(
      set(watchGithubIntegration$, signal),
      Reason.Entrance,
      "github settings realtime subscription",
    );

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
    ]);
  },
);
