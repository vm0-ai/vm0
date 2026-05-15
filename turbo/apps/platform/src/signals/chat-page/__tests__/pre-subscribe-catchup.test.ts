import { command, computed } from "ccstate";
import { describe, expect, it } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../__tests__/test-helpers.ts";
import type { ChatThread } from "../../agent-chat.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
} from "../create-chat-thread.ts";
import type { ChatThreadDataSource } from "../chat-thread-data-source.ts";

const context = testContext();

function createThread(activeRunIds: string[]): ChatThread {
  return {
    id: "thread-pre-subscribe",
    agentId: "agent-pre-subscribe",
    title: null,
    latestSessionId: null,
    lastReadMessageId: null,
    latestSessionProviderType: null,
    activeRunIds,
    activeRuns: activeRunIds.map((id) => {
      return { id, status: "running" };
    }),
    isLegacySession: false,
    draftContent: null,
    draftAttachments: null,
    modelProviderId: null,
    selectedModel: null,
  };
}

function createRemoteEmptyDataSource(input: {
  activeRunIds: string[];
  listAfterCalls: { count: number };
}): ChatThreadDataSource {
  const thread = createThread(input.activeRunIds);
  const fallbackMessage: PagedChatMessage = {
    id: "fallback-message",
    role: "user",
    content: null,
    createdAt: "2026-05-15T00:00:00Z",
  };

  return {
    getThread$: computed(() => {
      return Promise.resolve(thread);
    }),
    reloadThread$: command(() => {}),
    initialPage$: computed(() => {
      return Promise.resolve({
        messages: [],
        hasHistoryBefore: false,
        fetchedFromRemote: true,
      });
    }),
    patchDraft$: command(() => {
      return Promise.resolve();
    }),
    appendQueuedMessage$: command(() => {
      return Promise.resolve(fallbackMessage);
    }),
    recallMessage$: command(() => {
      return Promise.resolve(fallbackMessage);
    }),
    listMessagesAfter$: command(() => {
      input.listAfterCalls.count += 1;
      return Promise.resolve({ messages: [], reachedEnd: true });
    }),
    listMessagesBefore$: command(() => {
      return Promise.resolve({ messages: [], hasMore: false });
    }),
    cancelRuns$: command(() => {
      return Promise.resolve();
    }),
    markRead$: command(() => {
      return Promise.resolve(null);
    }),
    subscribeRealtime$: command(() => {
      return Promise.resolve();
    }),
  };
}

describe("subscribeChatThread$ pre-subscribe catch-up", () => {
  it("skips the no-cursor catch-up after a fresh remote empty page on an idle thread", async () => {
    const threadId = "thread-pre-subscribe-idle";
    const listAfterCalls = { count: 0 };
    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(
      threadId,
      draft,
      createRemoteEmptyDataSource({ activeRunIds: [], listAfterCalls }),
    );

    await context.store.set(thread.subscribeChatThread$, context.signal);

    expect(listAfterCalls.count).toBe(0);
  });

  it("keeps the no-cursor catch-up for a fresh remote empty page with active runs", async () => {
    const threadId = "thread-pre-subscribe-active";
    const listAfterCalls = { count: 0 };
    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(
      threadId,
      draft,
      createRemoteEmptyDataSource({
        activeRunIds: ["run-pre-subscribe"],
        listAfterCalls,
      }),
    );

    await context.store.set(thread.subscribeChatThread$, context.signal);

    expect(listAfterCalls.count).toBe(1);
  });
});
