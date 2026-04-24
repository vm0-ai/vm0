import { command } from "ccstate";
import { createElement } from "react";
import { AgentTalkPage } from "../../views/zero-page/agent-talk-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import {
  currentAgentId$,
  defaultAgentId$,
  rememberLastUsedAgentId$,
} from "../agent.ts";
import { setChatAgentId$, currentChatAgent$ } from "../agent-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  enterAgentChatVoiceMode$,
  exitAgentChatVoiceMode$,
} from "./agent-chat-voice-mode.ts";

export const setupAgentTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentTalkPage), "sidebar");
    set(updateDocumentTitle$, "Talk");

    // Tear down the WebRTC peer / mic / Ably loop when the user leaves the
    // talk route. The server-side session row is preserved and resumed on
    // next entry.
    signal.addEventListener("abort", () => {
      set(exitAgentChatVoiceMode$);
    });

    const agentId = get(currentAgentId$);
    if (agentId) {
      set(setChatAgentId$, agentId);
      set(rememberLastUsedAgentId$, agentId);
    }

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (!agentId) {
      throw new Error("Talk page requires an active agent, but none found");
    }

    const agent = await get(currentChatAgent$);
    signal.throwIfAborted();
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId) {
        throw new Error("Talk page requires an active agent, but none found");
      }
      set(detachedNavigateTo$, "/agents/:agentId/talk", {
        pathParams: { agentId: defaultAgentId },
        replace: true,
      });
      return;
    }

    set(updateDocumentTitle$, agent.displayName ?? "");

    // Auto-connect on mount. The command's inner Ably loop runs until the
    // page signal aborts, so awaiting here keeps the voice lifecycle tied
    // to the route.
    await set(enterAgentChatVoiceMode$, agentId, signal);
  },
);
