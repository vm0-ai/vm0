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

describe("latestRunStatus$", () => {
  it("ignores queued thread metadata when no message fact exists", async () => {
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
      await expect(
        context.store.get(thread.latestRunStatus$),
      ).resolves.toBeNull();
    });
  });

  it("reflects queued from an unrecalled assistant queue marker", async () => {
    const threadId = "thread-queue-marker-1";
    const runId = "run-queue-marker-1";

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
        return respond(200, {
          messages: [
            {
              id: "msg-queue-marker-active",
              role: "assistant",
              content: "Waiting in queue...",
              runId,
              createdAt: "2026-04-13T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
      await expect(context.store.get(thread.latestRunStatus$)).resolves.toBe(
        "queued",
      );
    });
  });

  it("treats assistant output as running even when thread data still says queued", async () => {
    const threadId = "thread-assistant-running-1";
    const runId = "run-assistant-running-1";

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
        return respond(200, {
          messages: [
            {
              id: "msg-assistant-started",
              role: "assistant",
              content: "The local-agent job is running...",
              runId,
              createdAt: "2026-04-13T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
        "running",
      );
    });
  });

  it("does not trust stale queued thread data after a queue marker is revoked", async () => {
    const threadId = "thread-revoked-queue-1";
    const runId = "run-revoked-queue-1";
    const markerId = "msg-queue-marker";

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
        return respond(200, {
          messages: [
            {
              id: markerId,
              role: "assistant",
              content: "Waiting in queue...",
              runId,
              createdAt: "2026-04-13T00:00:01Z",
            },
            {
              id: "msg-queue-marker-revoked",
              role: "assistant",
              content: null,
              runId,
              revokesMessageId: markerId,
              createdAt: "2026-04-13T00:00:02Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
      await expect(
        context.store.get(thread.latestRunStatus$),
      ).resolves.toBeNull();
    });
  });

  it("returns null after assistant output is followed by a completion marker", async () => {
    const threadId = "thread-completed-output-1";
    const runId = "run-completed-output-1";

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
        return respond(200, {
          messages: [
            {
              id: "msg-assistant-output",
              role: "assistant",
              content: "Done",
              runId,
              createdAt: "2026-04-13T00:00:01Z",
            },
            {
              id: "msg-assistant-completed",
              role: "assistant",
              content: null,
              runId,
              runLifecycleEvent: "completed",
              createdAt: "2026-04-13T00:00:02Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
