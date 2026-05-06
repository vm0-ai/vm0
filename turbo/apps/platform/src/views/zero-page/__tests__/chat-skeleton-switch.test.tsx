import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

describe("chat skeleton on switch", () => {
  it("should show skeleton when switching between chats", async () => {
    const threadBDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(
        chatThreadMessagesContract.list,
        async ({ params, query, respond }) => {
          if (query.sinceId) {
            return respond(200, { messages: [] });
          }
          const id = params.threadId;
          if (id === "thread-b") {
            await threadBDeferred.promise;
          }
          return respond(200, {
            messages: [
              {
                id: "msg-1",
                role: "user" as const,
                content: `Question for ${id}`,
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "msg-2",
                role: "assistant" as const,
                content: `Answer for ${id}`,
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        },
      ),
      mockApi(chatThreadByIdContract.get, async ({ params, respond }) => {
        const id = params.id;
        if (id === "thread-b") {
          await threadBDeferred.promise;
        }
        return respond(200, {
          id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Start on thread-A — messages load immediately
    detachedSetupPage({ context, path: "/chats/thread-a" });

    await waitFor(() => {
      expect(screen.getByText("Answer for thread-a")).toBeInTheDocument();
    });

    // Switch to thread-B — API is delayed, skeleton should appear
    await context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-b" },
    });

    // Skeleton should be visible while thread-B loads
    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    });

    // Release deferred so thread-B content loads
    threadBDeferred.resolve();

    // Eventually thread-B content should load
    await waitFor(() => {
      expect(screen.getByText("Answer for thread-b")).toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    });
  });

  it("does not re-fetch when navigating to the already-loaded thread", async () => {
    let initialFetchCount = 0;

    server.use(
      mockApi(chatThreadMessagesContract.list, ({ params, query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        initialFetchCount++;
        return respond(200, {
          messages: [
            {
              id: `msg-${params.threadId}-1`,
              role: "user" as const,
              content: `Question for ${params.threadId}`,
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: `msg-${params.threadId}-2`,
              role: "assistant" as const,
              content: `Answer for ${params.threadId}`,
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-a" });

    await waitFor(() => {
      expect(screen.getByText("Answer for thread-a")).toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    });

    // loadLeftThread$ is idempotent — navigating to the same thread is a no-op.
    await context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-a" },
    });

    // Content remains visible and no second fetch is triggered.
    expect(screen.getByText("Answer for thread-a")).toBeInTheDocument();
    expect(initialFetchCount).toBe(1);
  });
});
