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
import {
  currentAgentId$,
  defaultAgentId$,
  agents$,
  rememberLastUsedAgentId$,
} from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { reloadTagline$ } from "./zero-chat-page.ts";
import { setupAgentChatPageKeyboard$ } from "./agent-chat-keyboard.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";

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

    const agents = await get(agents$);
    signal.throwIfAborted();
    const agent = agents.find((candidate) => {
      return candidate.id === agentId;
    });
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId || defaultAgentId === agentId) {
        throw new Error("Chat page requires an active agent, but none found");
      }

      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    set(rememberLastUsedAgentId$, agentId);
    set(updateDocumentTitle$, agent.displayName ?? "Chat");

    const params = get(searchParams$);
    const prompt = params.get("prompt");
    const queue = params.get("queue");
    if (prompt) {
      set(get(talkDraft$).setInput$, prompt);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
    if (queue === "1") {
      set(openQueueDrawer$);
    }
  },
);
