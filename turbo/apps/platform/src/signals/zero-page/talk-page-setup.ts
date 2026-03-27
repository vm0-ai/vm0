import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPage } from "../../views/zero-page/zero-talk-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById$ } from "./zero-page.ts";
import { currentAgentId$ } from "./agent.ts";
import { setChatPageInput$ } from "./zero-chat-page.ts";
import { defaultAgentId$, agentDisplayName$ } from "./zero-agent-name.ts";
import { zeroSubagents$ } from "./zero-agents.ts";

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

    // Resolve and switch agent first — uses cached data, no extra API call.
    await set(resolveAgentById$, agentId, signal);
    signal.throwIfAborted();

    // Get display name from already-loaded data to avoid a separate
    // /api/zero/agents/:id round-trip on every navigation.
    const defaultId = await get(defaultAgentId$);
    signal.throwIfAborted();
    let agentName: string;
    if (agentId === defaultId) {
      agentName = (await get(agentDisplayName$)) ?? "Agent";
      signal.throwIfAborted();
    } else {
      const subagents = await get(zeroSubagents$);
      signal.throwIfAborted();
      agentName =
        subagents.find((a) => a.id === agentId)?.displayName ?? "Agent";
    }
    set(updateDocumentTitle$, agentName);

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
