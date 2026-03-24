import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPage } from "../../views/zero-page/zero-talk-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { navigateTo$, pathParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { logger } from "../log.ts";
import { agentDisplayName$, defaultAgentName$ } from "./zero-agent-name.ts";
import { zeroSubagents$ } from "./zero-agents.ts";
import { loadInitialData$, resolveAgentByName } from "./zero-page.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "./zero-onboarding.ts";

const L = logger("TalkPage");

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTalkPage));
    set(updateDocumentTitle$, "Chat");

    await set(loadInitialData$, signal);

    // Redirect to /onboarding when needed
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();
    if (needsOnboarding || needsMemberOnboarding) {
      set(navigateTo$, "/onboarding", { replace: true });
      return;
    }

    // Resolve agent from /talk/:name
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    L.info("resolveAgent talk:", agentName);

    await resolveAgentByName(get, set, signal, agentName);

    // Update title with resolved agent display name
    if (agentName) {
      const rawDefaultName = await get(defaultAgentName$);
      signal.throwIfAborted();
      if (agentName === rawDefaultName) {
        const displayName = await get(agentDisplayName$);
        signal.throwIfAborted();
        set(updateDocumentTitle$, displayName);
      } else {
        const subagents = await get(zeroSubagents$);
        signal.throwIfAborted();
        const agent = subagents.find((a) => a.name === agentName);
        const displayName =
          agent?.displayName ??
          agentName.charAt(0).toUpperCase() + agentName.slice(1);
        set(updateDocumentTitle$, displayName);
      }
    }

    set(syncModelPreference$);
  },
);
