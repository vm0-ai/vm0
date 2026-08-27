import { setupChatPage$ } from "../chat-page/chat-page-setup.ts";
import { setupAgentChatPage$ } from "../okou-page/agent-chat-page-setup.ts";
import { setupIdeationPage$ } from "../okou-page/ideation-page-setup.ts";
import { setupPromptPage$ } from "../prompt-page/prompt-page-setup.ts";

export function getChatRouteSetups() {
  return {
    setupAgentChatPage$,
    setupChatPage$,
    setupIdeationPage$,
    setupPromptPage$,
  };
}
