import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";

const context = testContext();

function mockChatThread() {
  server.use(
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-1",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [
          {
            role: "user",
            content: "Hello",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            role: "assistant",
            content: "Hi there!",
            createdAt: "2026-03-10T00:00:01Z",
          },
        ],
        latestSessionId: null,
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockQueueAPIs() {
  server.use(
    http.get("*/api/zero/runs/queue", () => {
      return HttpResponse.json({
        concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
        runningTasks: [],
        queue: [],
        estimatedTimePerRun: null,
      });
    }),
  );
}

describe("chat to queue navigation", () => {
  it("should open queue drawer when navigating from chat to /queues", async () => {
    mockChatThread();
    mockQueueAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    // Wait for chat to render
    await waitFor(() => {
      expect(screen.getByText("Hi there!")).toBeInTheDocument();
    });

    // Navigate to /queues — this opens the drawer and redirects to /
    act(() => {
      context.store.set(detachedNavigateTo$, "/queues");
    });

    // The queue drawer should open and show concurrency info
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
    });
  });
});
