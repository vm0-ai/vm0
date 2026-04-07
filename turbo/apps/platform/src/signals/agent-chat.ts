/**
 * Agent signals that depend on chat thread data (zero-chat.ts).
 *
 * Separated from agent.ts to avoid circular dependencies:
 *   agent.ts ← zero-chat.ts ← agent.ts
 */
import { command, computed, state } from "ccstate";
import { currentAgentId$, sidebarAgentId$ } from "./agent.ts";

import {
  chatThreadByIdContract,
  chatThreadsContract,
  type SummaryEntry,
} from "@vm0/core";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";

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

export const currentChatAgentId$ = computed(async (get) => {
  return get(currentAgentId$) ?? (await get(currentChatThread$))?.agentId;
});

const internalReloadChatThreads$ = state(0);

export const reloadChatThreads$ = command(({ set }) => {
  set(internalReloadChatThreads$, (n) => {
    return n + 1;
  });
});

export const chatThreads$ = computed(async (get) => {
  get(internalReloadChatThreads$);
  const agentId = await get(sidebarAgentId$);
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
