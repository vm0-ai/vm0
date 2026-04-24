import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
  type PersistedAttachment,
} from "@vm0/core/contracts/chat-threads";
import type { ModelProviderType } from "@vm0/core/contracts/model-providers";
import { agentById, defaultAgentId$ } from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { reloadChatThreadsCounter$ } from "./chat-thread-list-reload.ts";

export { reloadChatThreads$ } from "./chat-thread-list-reload.ts";

const internalChatAgentId$ = state<string | null>(null);

export const currentChatAgentId$ = computed(
  async (get): Promise<string | null> => {
    return get(internalChatAgentId$) ?? (await get(defaultAgentId$));
  },
);

export const setChatAgentId$ = command(({ set }, agentId: string | null) => {
  set(internalChatAgentId$, agentId);
});

export const currentChatAgent$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }

  return await get(agentById(agentId));
});

export const currentChatAgentDisplayName$ = computed(async (get) => {
  return (await get(currentChatAgent$))?.displayName;
});

export const currentChatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const threadId = params?.threadId;
  const route = get(activeRoute$);
  if (route !== "chat") {
    return null;
  }
  return typeof threadId === "string" ? threadId : null;
});

export interface ChatThread {
  id: string;
  agentId?: string;
  title: string | null;
  latestSessionId: string | null;
  /**
   * Provider type of the latest run in this thread. Null when the thread has
   * no runs yet. The composer picker uses this to disable options whose base
   * URL differs from the current session.
   */
  latestSessionProviderType: ModelProviderType | null;
  activeRunIds: string[];
  /**
   * Active (non-terminal) runs with live status. Source of truth for the
   * queued/running distinction — `activeRunIds` is derived from these ids.
   */
  activeRuns: { id: string; status: string }[];
  isLegacySession: boolean;
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
  /**
   * Per-thread model override. Both fields set together or both null. When
   * set, the send route uses this combination, overriding the agent and org
   * defaults, for the next run.
   */
  modelProviderId: string | null;
  selectedModel: string | null;
}

export const chatThreads$ = computed(async (get) => {
  get(reloadChatThreadsCounter$);

  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return [];
  }

  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(
    client.list({ query: { agentId: agentId } }),
    [200],
  );
  return result.body.threads;
});

/**
 * The earliest ended-but-unread thread that is not the currently open thread.
 * Used by the mobile header to prompt the user to check pending replies.
 */
export const earliestUnreadEndedThread$ = computed(
  async (get): Promise<ChatThreadListItem | null> => {
    const threads = await get(chatThreads$);
    const currentThreadId = get(currentChatThreadId$);

    const candidates = threads
      .filter((t) => {
        return !t.running && !t.isRead && t.id !== currentThreadId;
      })
      .sort((a, b) => {
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

    return candidates[0] ?? null;
  },
);
