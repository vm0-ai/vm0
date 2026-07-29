import { command } from "ccstate";
import { createElement } from "react";
import { AgentsPage } from "../../views/agents-page/agents-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { i18n } from "../../i18n/index.ts";

export const setupAgentsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.list.documentTitle;
        },
        { ns: "agents" },
      ),
    );
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
