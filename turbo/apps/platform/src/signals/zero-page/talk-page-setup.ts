import { command } from "ccstate";
import { createElement } from "react";
import { ZeroChatPage } from "../../views/zero-page/zero-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { loadInitialData$, resolveAgentById$ } from "./zero-page.ts";
import { currentAgentId$ } from "./agent.ts";
import { talkDraft$ } from "./chat-draft.ts";
import { defaultAgentId$, agentDisplayName$ } from "./zero-agent-name.ts";
import { zeroSubagents$ } from "./zero-agents.ts";
import { setSidebarChatAgent$ } from "./zero-nav.ts";

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroChatPage));
    set(updateDocumentTitle$, "Chat");

    // Reset the talk draft on entrance
    set(get(talkDraft$).clear$);

    // Read agent ID from URL immediately (synchronous) and update sidebar
    // highlight early so the UI responds without waiting for async data.
    const agentId = get(currentAgentId$);
    if (agentId) {
      set(setSidebarChatAgent$, agentId);
    }

    await set(loadInitialData$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (!agentId) {
      throw new Error("Talk page requires an active agent, but none found");
    }

    // Validate agent exists; redirect to default if unknown.
    await set(resolveAgentById$, agentId, signal);
    signal.throwIfAborted();

    // Get display name from already-loaded data to avoid a separate
    // /api/zero/agents/:id round-trip on every navigation.
    const defaultId = await get(defaultAgentId$);
    signal.throwIfAborted();

    // Correct sidebar to null when chatting with the default agent.
    if (agentId === defaultId) {
      set(setSidebarChatAgent$, null);
    }

    let agentName: string;
    if (agentId === defaultId) {
      agentName = (await get(agentDisplayName$)) ?? "Agent";
      signal.throwIfAborted();
    } else {
      const subagents = await get(zeroSubagents$);
      signal.throwIfAborted();
      agentName =
        subagents.find((a) => {
          return a.id === agentId;
        })?.displayName ?? "Agent";
    }
    set(updateDocumentTitle$, agentName);

    set(syncModelPreference$);

    // Inject ?prompt= into the chat input and clean up the URL
    const params = get(searchParams$);
    const prompt = params.get("prompt");
    if (prompt) {
      set(get(talkDraft$).setInput$, prompt);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
  },
);
