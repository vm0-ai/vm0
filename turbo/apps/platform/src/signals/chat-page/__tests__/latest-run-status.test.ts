import { describe, it, expect, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
} from "../create-chat-thread.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/core";

const context = testContext();

function createThreadSignals(threadId: string) {
  const { draft } = context.store.set(ensureDraft$, threadId);
  return createChatThreadSignals(threadId, draft);
}

/**
 * latestRunStatus$ sources run status from threadData$.activeRuns[0].status
 * rather than scanning paged messages — so UI can flip from "queued" to
 * "running" via the existing reloadThread$ hook on chatThreadRunUpdated
 * Ably events (which re-fetches the thread detail).
 *
 * These tests pin that contract: the signal mirrors whatever active run
 * status the server returned on the most recent fetch.
 */
describe("latestRunStatus$", () => {
  it("reflects 'queued' when the server reports the active run is queued", async () => {
    const threadId = "thread-queued-1";
    const runId = "run-queued-1";

    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          pinned: [],
          threads: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [runId],
          activeRuns: [{ id: runId, status: "queued" }],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-04-13T00:00:00Z",
          updatedAt: "2026-04-13T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      withoutRender: true,
    });

    const thread = createThreadSignals(threadId);

    await vi.waitFor(async () => {
      await expect(context.store.get(thread.latestRunStatus$)).resolves.toBe(
        "queued",
      );
    });
  });

  it("returns null when no active runs are attached to the thread", async () => {
    const threadId = "thread-idle-1";

    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          pinned: [],
          threads: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          activeRuns: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-04-13T00:00:00Z",
          updatedAt: "2026-04-13T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      withoutRender: true,
    });

    const thread = createThreadSignals(threadId);

    await vi.waitFor(async () => {
      await expect(
        context.store.get(thread.latestRunStatus$),
      ).resolves.toBeNull();
    });
  });

  it("defaults to empty active runs when the server omits the field (back-compat with older response shape)", async () => {
    const threadId = "thread-backcompat-1";

    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          pinned: [],
          threads: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        // No `activeRuns` field at all — simulates an older server that
        // predates the contract addition. latestRunStatus$ must not throw
        // and must treat this as "no active runs".
        return respond(200, {
          id: params.id,
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

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      withoutRender: true,
    });

    const thread = createThreadSignals(threadId);

    await expect(
      context.store.get(thread.latestRunStatus$),
    ).resolves.toBeNull();
  });
});
