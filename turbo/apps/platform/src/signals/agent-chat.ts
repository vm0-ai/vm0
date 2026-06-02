import { command, computed, state } from "ccstate";
import {
  chatThreadsContract,
  type ChatThreadListItem,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { reloadChatThreadsCounter$ } from "./chat-thread-list-reload.ts";
import { clerk$ } from "./auth.ts";
import { readThreadMeta$ } from "./external/idb-thread-meta-store.ts";

export { reloadChatThreads$ } from "./chat-thread-list-reload.ts";

const internalChatAgentId$ = state<string | null>(null);

export const setChatAgentId$ = command(({ set }, agentId: string | null) => {
  set(internalChatAgentId$, agentId);
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

const currentChatThreadAgentId$ = computed(
  async (get): Promise<string | null> => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return null;
    }

    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return null;
    }

    const meta = await readThreadMeta$(userId, orgId, threadId);
    return meta?.agentId ?? null;
  },
);

export const currentChatAgentId$ = computed(
  async (get): Promise<string | null> => {
    return (
      (await get(currentChatThreadAgentId$)) ??
      get(internalChatAgentId$) ??
      get(currentAgentId$) ??
      (await get(defaultAgentId$))
    );
  },
);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const currentChatAgentRecordId$ = computed(
  async (get): Promise<string | null> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return null;
    }

    if (uuidPattern.test(agentId)) {
      return agentId;
    }

    return (await get(agentById(agentId))).agentId;
  },
);

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

export interface ChatThread {
  id: string;
  agentId: string;
  title: string | null;
  latestSessionId: string | null;
  lastReadMessageId: string | null;
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
   * Per-thread selected model pin. Provider routing is resolved from the
   * current org policy when sending.
   */
  modelProviderId: string | null;
  selectedModel: string | null;
}

/**
 * First-page sidebar fetch: pinned (full) + up to 25 non-pinned. Returns the
 * raw page so derived signals (chatThreads$, hasMore, nextCursor) can share a
 * single network round-trip.
 */
const chatThreadsFirstPage$ = computed(async (get) => {
  get(reloadChatThreadsCounter$);

  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }

  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(
    client.list({ query: { agentId: agentId } }),
    [200],
  );
  return result.body;
});

export const chatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const page = await get(chatThreadsFirstPage$);
    if (!page) {
      return [];
    }
    return [...page.pinned, ...page.threads];
  },
);

/**
 * True when more non-pinned threads exist beyond the sidebar's 25-row cap.
 * Drives the "Load more" button rendered at the bottom of the sidebar list.
 */
export const chatThreadsHasMore$ = computed(async (get) => {
  const page = await get(chatThreadsFirstPage$);
  return page?.hasMore ?? false;
});

export const chatThreadsNextCursor$ = computed(async (get) => {
  const page = await get(chatThreadsFirstPage$);
  return page?.nextCursor ?? null;
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
