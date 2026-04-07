import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroIdeationPage } from "../../views/zero-page/zero-ideation-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById$ } from "./zero-page.ts";
import { currentAgentId$ } from "../agent.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupIdeationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroIdeationPage)),
    );
    set(updateDocumentTitle$, "Ideas & Use Cases");

    await set(loadInitialData$, signal);
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const agentId = get(currentAgentId$);
    if (agentId) {
      await set(resolveAgentById$, agentId, signal);
    }
  },
);
