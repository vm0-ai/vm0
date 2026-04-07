import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { AgentChatPage } from "../../views/zero-page/agent-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  searchParams$,
  updateSearchParams$,
  detachedNavigateTo$,
} from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { currentAgentId$, defaultAgentId$, subagents$ } from "../agent.ts";
import {
  setChatAgentId$,
  currentChatAgentDisplayName$,
} from "../agent-chat.ts";
import { talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { reloadTagline$ } from "./zero-chat-page.ts";

export const setupAgentChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(AgentChatPage)),
    );
    set(updateDocumentTitle$, "Chat");
    set(reloadTagline$);

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
      throw new Error("Talk page requires an active agent, but none found");
    }

    // Get display name from already-loaded data to avoid a separate
    // /api/zero/agents/:id round-trip on every navigation.
    const defaultId = await get(defaultAgentId$);
    signal.throwIfAborted();

    // Validate agent exists; redirect to default if unknown.
    if (agentId !== defaultId) {
      const subagentList = await get(subagents$);
      signal.throwIfAborted();
      const agentExists = subagentList.some((a) => {
        return a.id === agentId;
      });
      if (!agentExists && defaultId) {
        set(detachedNavigateTo$, "/agents/:id/chat", {
          pathParams: { id: defaultId },
          replace: true,
        });
        return;
      }
    }

    let agentName: string;
    if (agentId === defaultId) {
      agentName = (await get(currentChatAgentDisplayName$)) ?? "Agent";
      signal.throwIfAborted();
    } else {
      const subagents = await get(subagents$);
      signal.throwIfAborted();
      agentName =
        subagents.find((a) => {
          return a.id === agentId;
        })?.displayName ?? "Agent";
    }
    set(updateDocumentTitle$, agentName);

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
