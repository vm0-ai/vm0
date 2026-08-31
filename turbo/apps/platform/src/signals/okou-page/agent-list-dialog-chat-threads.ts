import { computed } from "ccstate";
import {
  chatSearchContract,
  type ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { chatListQuery$ } from "./sidebar-state.ts";

const MAX_VISIBLE_CHAT_THREAD_RESULTS = 25;
const MAX_AGENT_LIST_DIALOG_RESULTS = 25;
const MAX_AGENT_LIST_DIALOG_AGENT_RESULTS = 3;
const MAX_AGENT_LIST_DIALOG_THREAD_RESULTS = 3;

export interface AgentListDialogChatThread {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly sortAt: string;
}

interface AgentListDialogChatThreadResult {
  readonly query: string;
  readonly chatThreads: readonly AgentListDialogChatThread[];
}

interface AgentListDialogChatMessageResult {
  readonly query: string;
  readonly chatMessages: readonly ChatSearchResult[];
}

interface AgentListDialogSearchAgent {
  readonly agentId: string;
  readonly displayName?: string | null;
}

function agentSearchRank(
  agent: AgentListDialogSearchAgent,
  query: string,
): number | null {
  const values = [agent.displayName ?? "", agent.agentId].map((value) => {
    return value.toLowerCase();
  });
  if (
    values.some((value) => {
      return value.startsWith(query);
    })
  ) {
    return 0;
  }
  if (
    values.some((value) => {
      return value.includes(query);
    })
  ) {
    return 1;
  }
  return null;
}

export function rankAgentListDialogAgents<T extends AgentListDialogSearchAgent>(
  agents: readonly T[],
  query: string,
): T[] {
  return agents
    .map((agent, index) => {
      return { agent, index, rank: agentSearchRank(agent, query) };
    })
    .filter((entry): entry is typeof entry & { readonly rank: number } => {
      return entry.rank !== null;
    })
    .sort((left, right) => {
      return left.rank - right.rank || left.index - right.index;
    })
    .map((entry) => {
      return entry.agent;
    });
}

export function agentListDialogSearchResultCounts(args: {
  readonly agentCount: number;
  readonly threadCount: number;
  readonly messageCount: number;
}): {
  readonly agents: number;
  readonly threads: number;
  readonly messages: number;
} {
  const hasOtherResults = args.threadCount > 0 || args.messageCount > 0;
  const agents = Math.min(
    args.agentCount,
    MAX_AGENT_LIST_DIALOG_AGENT_RESULTS - (hasOtherResults ? 1 : 0),
  );
  const threads = Math.min(
    args.threadCount,
    MAX_AGENT_LIST_DIALOG_THREAD_RESULTS - (args.messageCount > 0 ? 1 : 0),
  );
  const messages = Math.min(
    args.messageCount,
    MAX_AGENT_LIST_DIALOG_RESULTS - agents - threads,
  );
  return { agents, threads, messages };
}

function agentListDialogChatThread(
  thread: EventDrivenChatThread,
): AgentListDialogChatThread {
  return {
    id: thread.id,
    title:
      thread.title ??
      i18n.t(($) => {
        return $.chat.newChat;
      }),
    agentId: thread.agentId,
    sortAt: thread.sortAt,
  };
}

export const agentListDialogChatThreadMap$ = computed((get) => {
  return new Map(
    get(eventDrivenChatThreads$).map((thread) => {
      const result = agentListDialogChatThread(thread);
      return [result.id, result] as const;
    }),
  );
});

export const agentListDialogChatThreads$ = computed(
  (get): AgentListDialogChatThreadResult => {
    const query = get(chatListQuery$).trim().toLowerCase();
    const threads = [...get(agentListDialogChatThreadMap$).values()];
    const matchingThreads: AgentListDialogChatThread[] = [];
    for (const thread of threads) {
      if (query && !thread.title.toLowerCase().includes(query)) {
        continue;
      }
      matchingThreads.push(thread);
    }
    if (query) {
      matchingThreads.sort((left, right) => {
        return (
          right.sortAt.localeCompare(left.sortAt) ||
          right.id.localeCompare(left.id)
        );
      });
    }
    return {
      query,
      chatThreads: matchingThreads.slice(0, MAX_VISIBLE_CHAT_THREAD_RESULTS),
    };
  },
);

export const agentListDialogChatMessages$ = computed(
  async (get): Promise<AgentListDialogChatMessageResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, chatMessages: [] };
    }
    const client = get(apiClient$)(chatSearchContract);
    const result = await accept(
      client.search({
        query: {
          keyword: query,
          limit: MAX_AGENT_LIST_DIALOG_RESULTS,
        },
      }),
      [200],
    );
    return { query, chatMessages: result.body.results };
  },
);
