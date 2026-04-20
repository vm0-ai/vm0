import { command, computed, state } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  type ModelProviderType,
  type PersistedAttachment,
} from "@vm0/core";
import { agentById, defaultAgentId$ } from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import {
  reloadChatThreads$,
  reloadChatThreadsCounter$,
} from "./chat-thread-list-reload.ts";

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

export const currentChatThread$ = computed(
  async (get): Promise<ChatThread | null> => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return null;
    }

    const threadClient = get(zeroClient$)(chatThreadByIdContract);

    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200],
    );

    const body = threadResult.body;
    return {
      id: threadId,
      title: body.title ?? null,
      agentId: body.agentId,
      latestSessionId: body.latestSessionId ?? null,
      latestSessionProviderType: body.latestSessionProviderType ?? null,
      activeRunIds: body.activeRunIds,
      isLegacySession: false,
      draftContent: body.draftContent ?? null,
      draftAttachments: body.draftAttachments ?? null,
      modelProviderId: body.modelProviderId ?? null,
      selectedModel: body.selectedModel ?? null,
    };
  },
);

/**
 * Mark a thread as read in the sidebar by triggering a full reload.
 * Uses reload (rather than in-place patch) so the server's authoritative
 * `last_read_at` value is reflected without client-side bookkeeping.
 */
export const patchThreadRead$ = command(({ set }, _threadId: string) => {
  set(reloadChatThreads$);
});

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
  const threads = result.body.threads;

  const currentThread = await get(currentChatThread$);
  return threads.map((t) => {
    return {
      ...t,
      title:
        t.id === currentThread?.id ? t.title || currentThread.title : t.title,
    };
  });
});
