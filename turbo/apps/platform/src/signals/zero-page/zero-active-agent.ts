import { computed } from "ccstate";
import { currentAgentId$ } from "./agent.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";
import { currentChatThread$ } from "./zero-chat.ts";

/**
 * Agent ID of the current chat thread.
 * Returns null when not on a /chat/:chatThreadId route or thread has no agent.
 */
const chatThreadAgentId$ = computed(async (get) => {
  const thread = await get(currentChatThread$);
  return thread?.agentId ?? null;
});

/**
 * The currently active chat agent ID, derived from URL and thread data.
 * Returns null when chatting with the default agent (null = default semantic).
 *
 * - On /talk/:agentId → from pathParams.agentId, normalized (default → null)
 * - On /chat/:chatThreadId → from currentChatThread$.agentId, normalized
 * - Otherwise → null
 */
export const zeroChatAgentId$ = computed(async (get) => {
  const agentId = get(currentAgentId$);
  if (agentId !== null) {
    const defaultId = await get(defaultAgentId$);
    return agentId === defaultId ? null : agentId;
  }

  const threadAgentId = await get(chatThreadAgentId$);
  if (threadAgentId !== null) {
    const defaultId = await get(defaultAgentId$);
    return threadAgentId === defaultId ? null : threadAgentId;
  }

  return null;
});
