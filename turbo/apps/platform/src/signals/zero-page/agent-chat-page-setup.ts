import { command } from "ccstate";
import { createElement } from "react";
import { AgentChatPage } from "../../views/zero-page/agent-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  searchParams$,
  updateSearchParams$,
  detachedNavigateTo$,
} from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { currentAgentId$, defaultAgentId$ } from "../agent.ts";
import { setChatAgentId$, currentChatAgent$ } from "../agent-chat.ts";
import { talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { reloadTagline$ } from "./zero-chat-page.ts";
import { setupAgentChatPageKeyboard$ } from "./agent-chat-keyboard.ts";

export const setupAgentChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentChatPage), "sidebar");
    set(updateDocumentTitle$, "Chat");
    set(reloadTagline$);
    set(setupAgentChatPageKeyboard$, signal);

    // Reset the talk draft on entrance
    set(get(talkDraft$).clear$);

    // Read agent ID from URL immediately (synchronous) and update sidebar
    // highlight early so the UI responds without waiting for async data.
    const agentId = get(currentAgentId$);
    if (agentId) {
      set(setChatAgentId$, agentId);
    }

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (!agentId) {
      throw new Error("Chat page requires an active agent, but none found");
    }

    const agent = await get(currentChatAgent$);
    signal.throwIfAborted();
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId) {
        throw new Error("Chat page requires an active agent, but none found");
      }

      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        replace: true,
      });
      return;
    }

    set(updateDocumentTitle$, agent.displayName ?? "");

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
