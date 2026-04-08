import { command, computed, state } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  type SummaryEntry,
} from "@vm0/core";
import { agentById, defaultAgentId$ } from "./agent.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept, ApiError } from "../lib/accept.ts";
import { throwIfAbort } from "./utils.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";

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

  // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() multi-status [200, 404]
  try {
    return await get(agentById(agentId));
  } catch (error) {
    throwIfAbort(error);
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
});

export const currentChatAgentDisplayName$ = computed(async (get) => {
  return (await get(currentChatAgent$))?.displayName;
});

export const currentChatAgentAvatarUrl$ = computed(async (get) => {
  const agent = await get(currentChatAgent$);
  return agent ? resolveAvatarUrl(agent.avatarUrl) : null;
});

export const currentChatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const id = params?.id;
  const route = get(activeRoute$);
  if (route !== "chat") {
    return null;
  }
  return typeof id === "string" ? id : null;
});

const internalReloadCurrentThread$ = state(0);

export const reloadCurrentChatThread$ = command(({ set }) => {
  set(internalReloadCurrentThread$, (v) => {
    return v + 1;
  });
});

export interface ChatThread {
  id: string;
  agentId?: string;
  title: string | null;
  chatMessages: {
    role: "user" | "assistant";
    content: string;
    runId?: string;
    error?: string;
    summaries?: SummaryEntry[];
    createdAt: string;
  }[];
  latestSessionId: string | null;
  unsavedRuns: {
    runId: string;
    status: string;
    prompt: string;
    error: string | null;
    createdAt: string;
  }[];
  isLegacySession: boolean;
}

export const currentChatThread$ = computed(
  async (get): Promise<ChatThread | null> => {
    get(internalReloadCurrentThread$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return null;
    }

    const threadClient = get(zeroClient$)(chatThreadByIdContract);

    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200],
      { toast: false },
    );

    const body = threadResult.body;
    return {
      id: threadId,
      title: body.title ?? null,
      agentId: body.agentId,
      chatMessages: body.chatMessages ?? [],
      latestSessionId: body.latestSessionId ?? null,
      unsavedRuns: body.unsavedRuns ?? [],
      isLegacySession: false,
    };
  },
);

const internalReloadChatThreads$ = state(0);

export const reloadChatThreads$ = command(({ set }) => {
  set(internalReloadChatThreads$, (n) => {
    return n + 1;
  });
});

export const chatThreads$ = computed(async (get) => {
  get(internalReloadChatThreads$);
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return [];
  }

  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(
    client.list({ query: { agentId: agentId } }),
    [200],
    { toast: false },
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
