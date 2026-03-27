import { command } from "ccstate";
import { createElement } from "react";
import { ZeroIdeationPage } from "../../views/zero-page/zero-ideation-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById$ } from "./zero-page.ts";
import { currentAgentId$ } from "./agent.ts";

export const setupIdeationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroIdeationPage));
    set(updateDocumentTitle$, "Ideas & Use Cases");

    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const agentId = get(currentAgentId$);
    if (agentId) {
      await set(resolveAgentById$, agentId, signal);
    }
  },
);
