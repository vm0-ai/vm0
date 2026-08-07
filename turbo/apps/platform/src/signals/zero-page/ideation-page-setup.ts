import { command } from "ccstate";
import { createElement } from "react";
import { ZeroIdeationPage } from "../../views/zero-page/zero-ideation-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { currentAgentId$, rememberLastUsedAgentId$ } from "../agent.ts";
import { i18n } from "../../i18n/index.ts";

export const setupIdeationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroIdeationPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.ideation.title;
        },
        { ns: "agents" },
      ),
    );

    const agentId = get(currentAgentId$);
    if (agentId) {
      set(rememberLastUsedAgentId$, agentId);
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(hideAppSkeleton$, signal);
  },
);
