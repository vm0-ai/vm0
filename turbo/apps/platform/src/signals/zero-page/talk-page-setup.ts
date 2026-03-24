import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPage } from "../../views/zero-page/zero-talk-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { logger } from "../log.ts";
import { agentDisplayName$, defaultAgentId$ } from "./zero-agent-name.ts";
import { zeroSubagents$ } from "./zero-agents.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById } from "./zero-page.ts";

const L = logger("TalkPage");

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTalkPage));
    set(updateDocumentTitle$, "Chat");

    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    // Resolve agent from /talk/:id
    const params = get(pathParams$) as { id?: string } | undefined;
    const agentId = params?.id ?? null;
    L.info("resolveAgent talk:", agentId);

    await resolveAgentById(get, set, signal, agentId);

    // Update title with resolved agent display name
    if (agentId) {
      const rawDefaultName = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (agentId === rawDefaultName) {
        const displayName = await get(agentDisplayName$);
        signal.throwIfAborted();
        set(updateDocumentTitle$, displayName);
      } else {
        const subagents = await get(zeroSubagents$);
        signal.throwIfAborted();
        const agent = subagents.find((a) => a.id === agentId);
        const displayName = agent?.displayName ?? "Agent";
        set(updateDocumentTitle$, displayName);
      }
    }

    set(syncModelPreference$);
  },
);
