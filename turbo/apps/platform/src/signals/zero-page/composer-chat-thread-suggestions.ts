import { computed, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { agents$ } from "../agent.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import type { ComposerAgentSuggestion } from "./composer-agent-suggestion-domain.ts";
import type {
  ChatThreadSuggestionRange,
  ComposerChatThreadSuggestion,
} from "./chat-thread-suggestion-domain.ts";

const MAX_DEFAULT_AGENT_SUGGESTIONS = 3;
const MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS = 25;

export interface ComposerChatThreadSuggestionResult {
  readonly agentId: string | null;
  readonly query: string | null;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
}

export function createComposerChatThreadSuggestions(
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
  agentId$: Computed<Promise<string | null>>,
): Computed<Promise<ComposerChatThreadSuggestionResult>> {
  return computed(async (get): Promise<ComposerChatThreadSuggestionResult> => {
    const range = get(activeRange$);
    if (!range) {
      return {
        agentId: null,
        query: null,
        agents: [],
        chatThreads: [],
      };
    }

    const agentId = await get(agentId$);
    if (!agentId) {
      return {
        agentId: null,
        query: range.query,
        agents: [],
        chatThreads: [],
      };
    }

    const query = range.query.toLowerCase();
    const allAgents = await get(agents$);
    const agentAvatarUrls = new Map(
      allAgents.map((agent) => {
        return [agent.id, agent.avatarUrl] as const;
      }),
    );
    const agentSuggestions: ComposerAgentSuggestion[] = [];
    const zeroChatMessagingEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ZeroChatMessaging] ?? false;
    if (zeroChatMessagingEnabled) {
      for (const agent of allAgents) {
        const name = agent.displayName ?? agent.id;
        if (agent.id === agentId || !name.toLowerCase().includes(query)) {
          continue;
        }
        agentSuggestions.push({
          id: agent.id,
          name,
          avatarUrl: agent.avatarUrl,
        });
        if (
          range.query.length === 0 &&
          agentSuggestions.length === MAX_DEFAULT_AGENT_SUGGESTIONS
        ) {
          break;
        }
      }
    }

    const chatThreads: ComposerChatThreadSuggestion[] = [];
    for (const thread of get(eventDrivenChatThreads$)) {
      const title = thread.title;
      if (
        (!zeroChatMessagingEnabled && thread.agentId !== agentId) ||
        !title ||
        !title.toLowerCase().includes(query)
      ) {
        continue;
      }
      chatThreads.push({
        id: thread.id,
        title,
        avatarUrl: agentAvatarUrls.get(thread.agentId) ?? null,
      });
      if (chatThreads.length === MAX_VISIBLE_CHAT_THREAD_SUGGESTIONS) {
        break;
      }
    }

    return {
      agentId,
      query: range.query,
      agents: agentSuggestions,
      chatThreads,
    };
  });
}
