import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPage } from "../../views/zero-page/zero-talk-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById$ } from "./zero-page.ts";
import { currentAgentDisplayName$, currentAgentId$ } from "./agent.ts";
import { setChatPageInput$ } from "./zero-chat-page.ts";

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTalkPage));
    set(updateDocumentTitle$, "Chat");

    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const agentId = get(currentAgentId$);
    if (!agentId) {
      throw new Error("Talk page requires an active agent, but none found");
    }

    const agentName = await get(currentAgentDisplayName$);
    signal.throwIfAborted();

    set(updateDocumentTitle$, agentName ?? "Agent");
    await set(resolveAgentById$, agentId, signal);

    set(syncModelPreference$);

    // Inject ?prompt= into the chat input and clean up the URL
    const params = get(searchParams$);
    const prompt = params.get("prompt");
    if (prompt) {
      set(setChatPageInput$, prompt);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
  },
);
