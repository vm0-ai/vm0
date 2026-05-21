import { command } from "ccstate";
import { createElement } from "react";
import { ZeroGithubSettingsPage } from "../../views/zero-page/zero-github-settings-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupGithubSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroGithubSettingsPage), "sidebar");
    set(updateDocumentTitle$, "GitHub");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
    ]);
  },
);
