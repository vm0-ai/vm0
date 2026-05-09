import { describe, it, expect, beforeEach } from "vitest";
import { command, computed } from "ccstate";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  setDraftSyncDebounceMs$,
} from "../create-chat-thread.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  AppendQueuedMessageArgs,
  ChatThreadDataSource,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  PatchDraftArgs,
  CancelRunsArgs,
  RecallMessageArgs,
  SubscribeRealtimeArgs,
} from "../chat-thread-data-source.ts";

const context = testContext();
const mockApi = createMockApi(context);

/**
 * Base MSW handlers required for setupChatPage$ to complete:
 * - GET /api/zero/chat-threads — sidebar thread list
 * - GET /api/zero/chat-threads/:id — thread detail (no active runs)
 * - GET /api/zero/chat-threads/:id/messages — paged messages (empty)
 */
function setupBaseHandlers(threadId: string) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-04-13T00:00:00Z",
        updatedAt: "2026-04-13T00:00:00Z",
      });
    }),
  );
}

function createThreadSignals(threadId: string) {
  const { draft } = context.store.set(ensureDraft$, threadId);
  return createChatThreadSignals(threadId, draft);
}

function createStaticDataSource({
  threadId,
  initialPage,
  listMessagesAfter,
  listMessagesBefore,
}: {
  threadId: string;
  initialPage: InitialPage;
  listMessagesAfter?: (
    args: ListMessagesAfterArgs,
  ) => Promise<{ messages: PagedChatMessage[]; reachedEnd: boolean }>;
  listMessagesBefore?: (
    args: ListMessagesBeforeArgs,
  ) => Promise<{ messages: PagedChatMessage[]; hasMore: boolean }>;
}): ChatThreadDataSource {
  return {
    getThread$: computed(() => {
      return Promise.resolve({
        id: threadId,
        title: null,
        agentId: "agent-1",
        latestSessionId: null,
        lastReadMessageId: null,
        latestSessionProviderType: null,
        activeRunIds: [],
        activeRuns: [],
        isLegacySession: false,
        draftContent: null,
        draftAttachments: null,
        modelProviderId: null,
        selectedModel: null,
      });
    }),
    reloadThread$: command(() => {}),
    initialPage$: computed(() => {
      return Promise.resolve(initialPage);
    }),
    patchDraft$: command(
      (_ctx, _args: PatchDraftArgs, _signal: AbortSignal) => {
        return Promise.resolve();
      },
    ),
    appendQueuedMessage$: command(
      (_ctx, args: AppendQueuedMessageArgs, _signal: AbortSignal) => {
        return Promise.resolve({
          id: args.clientMessageId,
          role: "user",
          content: args.content,
          attachFiles: args.attachments ?? undefined,
          createdAt: "2026-05-01T00:00:00Z",
        });
      },
    ),
    recallMessage$: command(
      (_ctx, args: RecallMessageArgs, _signal: AbortSignal) => {
        return Promise.resolve({
          id: args.clientMessageId,
          role: "user",
          content: null,
          revokesMessageId: args.revokesMessageId,
          createdAt: "2026-05-01T00:00:00Z",
        });
      },
    ),
    listMessagesAfter$: command((_ctx, args) => {
      return (
        listMessagesAfter?.(args) ??
        Promise.resolve({ messages: [], reachedEnd: true })
      );
    }),
    listMessagesBefore$: command((_ctx, args) => {
      return (
        listMessagesBefore?.(args) ??
        Promise.resolve({ messages: [], hasMore: false })
      );
    }),
    cancelRuns$: command(
      (_ctx, _args: CancelRunsArgs, _signal: AbortSignal) => {
        return Promise.resolve();
      },
    ),
    markRead$: command(() => {
      return Promise.resolve(null);
    }),
    subscribeRealtime$: command(
      (_ctx, _args: SubscribeRealtimeArgs, _signal: AbortSignal) => {
        return Promise.resolve();
      },
    ),
  };
}

describe("createDraftSync — scheduleDraftSync$, cancelDraftSync$, flushDraftClear$", () => {
  beforeEach(() => {
    // Override debounce delay to 0 so tests resolve without fake timers.
    context.store.set(setDraftSyncDebounceMs$, 0);
  });

  describe("scheduleDraftSync$", () => {
    it("should PATCH the server with the current draft after debounce", async () => {
      const threadId = "thread-draft-sync-1";
      let patchBody: unknown = null;

      server.use(
        mockApi(chatThreadByIdContract.patch, ({ body, respond }) => {
          patchBody = body;
          return respond(204);
        }),
      );
      setupBaseHandlers(threadId);

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = createThreadSignals(threadId);

      // Set draft input so the PATCH has content to sync
      context.store.set(thread.draft.setInput$, "hello world");

      // Schedule a debounced sync (debounce is 0ms in tests)
      await context.store.set(thread!.scheduleDraftSync$, context.signal);

      // Wait for the PATCH to arrive
      await expect
        .poll(
          () => {
            return patchBody;
          },
          { timeout: 1000 },
        )
        .not.toBeNull();

      expect(patchBody).toMatchObject({
        draftContent: "hello world",
        draftAttachments: null,
      });
    });

    it("should debounce: only the last call triggers PATCH", async () => {
      const threadId = "thread-draft-sync-2";
      let patchCount = 0;

      server.use(
        mockApi(chatThreadByIdContract.patch, ({ respond }) => {
          patchCount++;
          return respond(204);
        }),
      );
      setupBaseHandlers(threadId);

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = createThreadSignals(threadId);

      // Schedule sync, then schedule again immediately to reset the timer.
      // The first signal is aborted synchronously before its setTimeout(0) fires.
      context.store.set(thread.draft.setInput$, "first");
      const first = context.store.set(
        thread.scheduleDraftSync$,
        context.signal,
      );

      // Second call resets the debounce (aborts the first timer)
      context.store.set(thread.draft.setInput$, "second");
      const second = context.store.set(
        thread.scheduleDraftSync$,
        context.signal,
      );

      // First call should be aborted, second should succeed
      await expect(first).rejects.toThrow();
      await second;

      // Wait for exactly one PATCH from the second call
      await expect
        .poll(
          () => {
            return patchCount;
          },
          { timeout: 1000 },
        )
        .toBe(1);
    });

    it("should send null draft content when input is empty", async () => {
      const threadId = "thread-draft-sync-empty";
      let patchBody: unknown = null;

      server.use(
        mockApi(chatThreadByIdContract.patch, ({ body, respond }) => {
          patchBody = body;
          return respond(204);
        }),
      );
      setupBaseHandlers(threadId);

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = createThreadSignals(threadId);

      // Leave input empty — should send null draftContent
      await context.store.set(thread.scheduleDraftSync$, context.signal);

      await expect
        .poll(
          () => {
            return patchBody;
          },
          { timeout: 1000 },
        )
        .not.toBeNull();

      expect(patchBody).toMatchObject({
        draftContent: null,
        draftAttachments: null,
      });
    });
  });
});

describe("fetchNextPage$ cursor", () => {
  it("groups assistant messages across queued user messages", async () => {
    const threadId = "thread-group-queued";
    const mockDataSource = createStaticDataSource({
      threadId,
      initialPage: {
        hasHistoryBefore: false,
        messages: [
          {
            id: "assistant-before",
            role: "assistant",
            content: "before",
            runId: "run-1",
            createdAt: "2026-05-01T00:00:00Z",
          },
          {
            id: "queued-user",
            role: "user",
            content: "queued",
            createdAt: "2026-05-01T00:00:01Z",
          },
          {
            id: "assistant-after",
            role: "assistant",
            content: "after",
            runId: "run-1",
            createdAt: "2026-05-01T00:00:02Z",
          },
        ],
      },
    });

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    const groups = await context.store.get(thread.groupedChatMessages$);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.role).toBe("assistant");
    expect(
      groups[0]?.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual(["assistant-before", "assistant-after"]);
    expect(groups[1]?.role).toBe("user");
    expect(groups[1]?.messages[0]?.id).toBe("queued-user");
    expect(groups[1]?.messages[0]?.isQueued).toBeTruthy();
  });

  it("projects recall events as recalled pending user messages", async () => {
    const threadId = "thread-recalled-queued";
    const mockDataSource = createStaticDataSource({
      threadId,
      initialPage: {
        hasHistoryBefore: false,
        messages: [
          {
            id: "queued-user",
            role: "user",
            content: "queued",
            createdAt: "2026-05-01T00:00:00Z",
          },
          {
            id: "assistant-after",
            role: "assistant",
            content: "after",
            runId: "run-1",
            createdAt: "2026-05-01T00:00:01Z",
          },
          {
            id: "recall-event",
            role: "user",
            content: null,
            revokesMessageId: "queued-user",
            createdAt: "2026-05-01T00:00:02Z",
          },
        ],
      },
    });

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    const groups = await context.store.get(thread.groupedChatMessages$);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.role).toBe("assistant");
    expect(groups[0]?.messages[0]?.id).toBe("assistant-after");
    expect(groups[1]?.role).toBe("user");
    expect(groups[1]?.messages).toHaveLength(1);
    expect(groups[1]?.messages[0]?.id).toBe("recall-event");
    expect(groups[1]?.messages[0]?.content).toBe("queued");
    expect(groups[1]?.messages[0]?.isQueued).toBeFalsy();
    expect(groups[1]?.messages[0]?.isRecalled).toBeTruthy();
  });

  it("auto backfills an unknown cached history boundary during subscribe", async () => {
    const threadId = "thread-history-boundary-backfill";
    const firstMessageId = "11111111-1111-4111-8111-111111111111";
    const secondMessageId = "22222222-2222-4222-8222-222222222222";
    const beforeIds: string[] = [];
    const initialMessages: PagedChatMessage[] = [
      {
        id: firstMessageId,
        role: "user",
        content: "hi",
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        id: secondMessageId,
        role: "assistant",
        content: "hello",
        createdAt: "2026-05-01T00:00:01Z",
      },
    ];

    const mockDataSource = createStaticDataSource({
      threadId,
      initialPage: {
        messages: initialMessages,
        hasHistoryBefore: false,
        needsHistoryBackfill: true,
      },
      listMessagesBefore: (args) => {
        beforeIds.push(args.beforeId);
        return Promise.resolve({ messages: [], hasMore: false });
      },
    });

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    await expect(
      context.store.get(thread.hasOlderHistory$),
    ).resolves.toBeFalsy();
    await context.store.set(thread.subscribeChatThread$, context.signal);

    expect(beforeIds).toStrictEqual([firstMessageId]);
    await expect(
      context.store.get(thread.hasOlderHistory$),
    ).resolves.toBeFalsy();
  });

  it("uses the last server-validated message ID, not the optimistic message ID", async () => {
    const threadId = "thread-cursor-test";
    const serverMessages: PagedChatMessage[] = [
      {
        id: "server-msg-1",
        role: "user",
        content: "hello",
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        id: "server-msg-2",
        role: "assistant",
        content: "hi there",
        createdAt: "2026-05-01T00:00:01Z",
      },
    ];

    let capturedSinceId: string | undefined;

    const mockDataSource: ChatThreadDataSource = {
      getThread$: computed(() => {
        return Promise.resolve({
          id: threadId,
          title: null,
          agentId: "agent-1",
          latestSessionId: null,
          lastReadMessageId: null,
          latestSessionProviderType: null,
          activeRunIds: [],
          activeRuns: [],
          isLegacySession: false,
          draftContent: null,
          draftAttachments: null,
          modelProviderId: null,
          selectedModel: null,
        });
      }),
      reloadThread$: command(() => {}),
      initialPage$: computed(() => {
        return Promise.resolve({
          messages: serverMessages,
          hasHistoryBefore: false,
        });
      }),
      patchDraft$: command(
        (_ctx, _args: PatchDraftArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      appendQueuedMessage$: command(
        (_ctx, args: AppendQueuedMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: args.content,
            attachFiles: args.attachments ?? undefined,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      recallMessage$: command(
        (_ctx, args: RecallMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: null,
            revokesMessageId: args.revokesMessageId,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      listMessagesAfter$: command((_, args) => {
        capturedSinceId = args.sinceId;
        return Promise.resolve({ messages: [], reachedEnd: true });
      }),
      listMessagesBefore$: command(() => {
        return Promise.resolve({
          messages: [],
          hasMore: false,
        });
      }),
      cancelRuns$: command(
        (_ctx, _args: CancelRunsArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      markRead$: command(() => {
        return Promise.resolve(null);
      }),
      subscribeRealtime$: command(
        (_ctx, _args: SubscribeRealtimeArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
    };

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    // Insert an optimistic message with a client-generated UUID
    context.store.set(thread.insertOptimisticMessage$, {
      id: crypto.randomUUID(),
      role: "user",
      content: "optimistic message",
      optimisticAssociation: "run",
      createdAt: new Date().toISOString(),
    });

    // Call fetchNextPage$ — this triggers listMessagesAfter$ with a sinceId
    await context.store.set(thread.fetchNextPage$, context.signal);

    // The sinceId must be the last server-validated ID, not the optimistic UUID.
    // If optimistic IDs leak into the cursor, the server can't resolve them
    // and returns empty, so the real server message never reaches the client.
    expect(capturedSinceId).toBe("server-msg-2");
  });

  it("issues a no-cursor fetch when initialPage is empty", async () => {
    // Brand-new thread scenario: the swap-time `initialPage$` fetch returns
    // empty because the send POST has not yet persisted the user row. With
    // no anchor, `fetchNextPage$` must still query the server (sinceId is
    // optional in the contract — passing it as undefined returns the latest
    // page) and ingest whatever lands. Without this, every Ably-triggered
    // refetch exits early and the rendered list stays stuck on the thinking
    // indicator until the user manually refreshes.
    const threadId = "thread-cursor-no-anchor";
    const userMessageId = "11111111-1111-4111-8111-111111111111";
    const assistantMessageId = "22222222-2222-4222-8222-222222222222";
    const serverMessages: PagedChatMessage[] = [
      {
        id: userMessageId,
        role: "user",
        content: "hi",
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "hello back",
        createdAt: "2026-05-01T00:00:01Z",
      },
    ];

    const capturedSinceIds: (string | undefined)[] = [];

    const mockDataSource: ChatThreadDataSource = {
      getThread$: computed(() => {
        return Promise.resolve({
          id: threadId,
          title: null,
          agentId: "agent-1",
          latestSessionId: null,
          lastReadMessageId: null,
          latestSessionProviderType: null,
          activeRunIds: [],
          activeRuns: [],
          isLegacySession: false,
          draftContent: null,
          draftAttachments: null,
          modelProviderId: null,
          selectedModel: null,
        });
      }),
      reloadThread$: command(() => {}),
      initialPage$: computed(() => {
        return Promise.resolve({
          messages: [],
          hasHistoryBefore: false,
        });
      }),
      patchDraft$: command(
        (_ctx, _args: PatchDraftArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      appendQueuedMessage$: command(
        (_ctx, args: AppendQueuedMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: args.content,
            attachFiles: args.attachments ?? undefined,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      recallMessage$: command(
        (_ctx, args: RecallMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: null,
            revokesMessageId: args.revokesMessageId,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      listMessagesAfter$: command((_ctx, args) => {
        capturedSinceIds.push(args.sinceId);
        // First call (no anchor): return the full page the server has now.
        // Second call (cursor advanced to assistant id): nothing new.
        if (args.sinceId === undefined) {
          return Promise.resolve({
            messages: serverMessages,
            reachedEnd: true,
          });
        }
        return Promise.resolve({ messages: [], reachedEnd: true });
      }),
      listMessagesBefore$: command(() => {
        return Promise.resolve({ messages: [], hasMore: false });
      }),
      cancelRuns$: command(
        (_ctx, _args: CancelRunsArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      markRead$: command(() => {
        return Promise.resolve(null);
      }),
      subscribeRealtime$: command(
        (_ctx, _args: SubscribeRealtimeArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
    };

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    await context.store.set(thread.fetchNextPage$, context.signal);

    expect(capturedSinceIds[0]).toBeUndefined();

    const groups = await context.store.get(thread.groupedChatMessages$);
    const ids = groups.flatMap((g) => {
      return g.messages.map((m) => {
        return m.id;
      });
    });
    expect(ids).toContain(userMessageId);
    expect(ids).toContain(assistantMessageId);

    // Subsequent calls advance the cursor to the last server-validated id.
    await context.store.set(thread.fetchNextPage$, context.signal);
    expect(capturedSinceIds[capturedSinceIds.length - 1]).toBe(
      assistantMessageId,
    );
  });

  it("loops until reachedEnd when a single page is not enough", async () => {
    const threadId = "thread-drain-loop";

    const baselineMessages: PagedChatMessage[] = [
      {
        id: "base-1",
        role: "user",
        content: "baseline",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ];

    // 3 pages worth: page1 (50), page2 (50), page3 (20) → total 120
    const page1 = Array.from({ length: 50 }, (_, i) => {
      return {
        id: `p1-${i}`,
        role: "user" as const,
        content: `page1 msg ${i}`,
        createdAt: "2026-05-01T00:00:01Z",
      };
    });
    const page2 = Array.from({ length: 50 }, (_, i) => {
      return {
        id: `p2-${i}`,
        role: "user" as const,
        content: `page2 msg ${i}`,
        createdAt: "2026-05-01T00:00:02Z",
      };
    });
    const page3 = Array.from({ length: 20 }, (_, i) => {
      return {
        id: `p3-${i}`,
        role: "user" as const,
        content: `page3 msg ${i}`,
        createdAt: "2026-05-01T00:00:03Z",
      };
    });

    let callCount = 0;

    const mockDataSource: ChatThreadDataSource = {
      getThread$: computed(() => {
        return Promise.resolve({
          id: threadId,
          title: null,
          agentId: "agent-1",
          latestSessionId: null,
          lastReadMessageId: null,
          latestSessionProviderType: null,
          activeRunIds: [],
          activeRuns: [],
          isLegacySession: false,
          draftContent: null,
          draftAttachments: null,
          modelProviderId: null,
          selectedModel: null,
        });
      }),
      reloadThread$: command(() => {}),
      initialPage$: computed(() => {
        return Promise.resolve({
          messages: baselineMessages,
          hasHistoryBefore: false,
        });
      }),
      patchDraft$: command(
        (_ctx, _args: PatchDraftArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      appendQueuedMessage$: command(
        (_ctx, args: AppendQueuedMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: args.content,
            attachFiles: args.attachments ?? undefined,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      recallMessage$: command(
        (_ctx, args: RecallMessageArgs, _signal: AbortSignal) => {
          return Promise.resolve({
            id: args.clientMessageId,
            role: "user",
            content: null,
            revokesMessageId: args.revokesMessageId,
            createdAt: "2026-05-01T00:00:00Z",
          });
        },
      ),
      listMessagesAfter$: command((_ctx, _args) => {
        callCount++;
        const pages = [page1, page2, page3];
        const idx = callCount - 1;
        if (idx < pages.length) {
          const chunk = pages[idx]!;
          return Promise.resolve({
            messages: chunk,
            reachedEnd: chunk.length < 50,
          });
        }
        return Promise.resolve({ messages: [], reachedEnd: true });
      }),
      listMessagesBefore$: command(() => {
        return Promise.resolve({
          messages: [],
          hasMore: false,
        });
      }),
      cancelRuns$: command(
        (_ctx, _args: CancelRunsArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
      markRead$: command(() => {
        return Promise.resolve(null);
      }),
      subscribeRealtime$: command(
        (_ctx, _args: SubscribeRealtimeArgs, _signal: AbortSignal) => {
          return Promise.resolve();
        },
      ),
    };

    const { draft } = context.store.set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft, mockDataSource);

    const done = await context.store.set(thread.fetchNextPage$, context.signal);

    // With the drain-loop fix, all 3 pages are fetched before returning.
    // The 3rd page has < 50 messages, so reachedEnd fires on it (not on
    // the 4th empty call).
    expect(callCount).toBe(3);
    expect(done).toBeTruthy();

    // Verify all messages appear in the grouped output
    const groups = await context.store.get(thread.groupedChatMessages$);
    const allContent = groups.flatMap((g) => {
      return g.messages.map((m) => {
        return m.content;
      });
    });
    expect(allContent).toContain("baseline");
    expect(allContent).toContain("page1 msg 0");
    expect(allContent).toContain("page1 msg 49");
    expect(allContent).toContain("page2 msg 0");
    expect(allContent).toContain("page2 msg 49");
    expect(allContent).toContain("page3 msg 0");
    expect(allContent).toContain("page3 msg 19");
  });
});
