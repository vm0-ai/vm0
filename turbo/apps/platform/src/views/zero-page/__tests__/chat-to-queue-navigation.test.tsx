import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { openQueueDrawer$ } from "../../../signals/queue-page/queue-drawer-state.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";

const context = testContext();

function mockChatThread() {
  server.use(
    mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      return respond(200, {
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Hello",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Hi there!",
            createdAt: "2026-03-10T00:00:01Z",
          },
        ],
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "thread-1",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
  );
}

function mockQueueAPIs() {
  server.use(
    mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(200, {
        concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
        runningTasks: [],
        queue: [],
        estimatedTimePerRun: null,
      });
    }),
  );
}

describe("chat to queue navigation", () => {
  it("should open queue drawer when opening queue from chat", async () => {
    mockChatThread();
    mockQueueAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    // Wait for chat to render
    await waitFor(() => {
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });

    // Open queue drawer (simulates clicking the queues nav item)
    act(() => {
      context.store.set(openQueueDrawer$, context.signal);
    });

    // The queue drawer should open and show concurrency info
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
    });
  });
});
