/**
 * Agent signals that depend on chat thread data (zero-chat.ts).
 *
 * Separated from agent.ts to avoid circular dependencies:
 *   agent.ts ← zero-chat.ts ← agent.ts
 */
import { computed } from "ccstate";
import {
  currentAgentId$,
  currentChatThreadId$,
  sidebarSubagents$,
} from "./agent.ts";
import { currentChatThread$, chatThreads$ } from "./zero-page/zero-chat.ts";
import { zeroOnboardingStatus$ } from "./zero-page/zero-onboarding.ts";

/**
 * The currently active chat agent ID, derived from URL and thread data.
 * Returns null when chatting with the default agent (null = default semantic).
 *
 * - On /agents/:id/chat → from pathParams.id, normalized (default → null)
 * - On /chats/:id → from currentChatThread$.agentId, normalized
 * - Otherwise → null
 */
export const activeChatAgentId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  const defaultId = status.defaultAgentId;

  const agentId = get(currentAgentId$);
  if (agentId !== null) {
    return agentId === defaultId ? null : agentId;
  }

  const thread = await get(currentChatThread$);
  const threadAgentId = thread?.agentId ?? null;
  if (threadAgentId !== null) {
    return threadAgentId === defaultId ? null : threadAgentId;
  }

  return null;
});

/**
 * When the user selects a recent chat thread, resolves to the agent ID
 * that owns that thread (if it's a subagent), `null` if the thread
 * belongs to the default agent, or `undefined` if no thread is selected.
 */
export const currentChatAgentId$ = computed(async (get) => {
  const chatThreadId = get(currentChatThreadId$);
  if (!chatThreadId) {
    return undefined;
  }

  const threads = await get(chatThreads$);
  const thread = threads.find((s) => {
    return s.id === chatThreadId;
  });
  if (!thread) {
    return undefined;
  }

  const subs = await get(sidebarSubagents$);
  const subIds = new Set(
    subs.map((a) => {
      return a.id;
    }),
  );
  return subIds.has(thread.agentId) ? thread.agentId : null;
});
