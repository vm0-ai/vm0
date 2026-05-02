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
  ChatThreadDataSource,
  PatchDraftArgs,
  CancelRunsArgs,
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
      createdAt: new Date().toISOString(),
    });

    // Call fetchNextPage$ — this triggers listMessagesAfter$ with a sinceId
    await context.store.set(thread.fetchNextPage$, context.signal);

    // The sinceId must be the last server-validated ID, not the optimistic UUID.
    // If optimistic IDs leak into the cursor, the server can't resolve them
    // and returns empty, so the real server message never reaches the client.
    expect(capturedSinceId).toBe("server-msg-2");
  });
});
