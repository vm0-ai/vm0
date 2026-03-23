import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { navigateTo$ } from "../../../signals/route.ts";

const context = testContext();

function mockChatThread() {
  server.use(
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-1",
        title: null,
        agentComposeId: "mock-compose-id",
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
        concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
        runningTasks: [
          {
            runId: "run-1",
            agentName: "queue-agent",
            agentDisplayName: "Queue Agent",
            userEmail: "me@test.com",
            startedAt: new Date().toISOString(),
            isOwner: true,
          },
        ],
        queue: [],
        estimatedTimePerRun: null,
      });
    }),
  );
}

describe("chat to queue navigation", () => {
  it("should initialize queue page when navigating from chat", async () => {
    mockChatThread();
    mockQueueAPIs();

    await setupPage({ context, path: "/chat/thread-1" });

    // Wait for chat to render
    await waitFor(
      () => {
        expect(screen.getByText("Hi there!")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Navigate to /queue using navigateTo$ (same as Link component)
    act(() => {
      context.store.set(navigateTo$, "/queue");
    });

    // The queue page should fully initialize and show queue data
    await waitFor(
      () => {
        expect(screen.getByText("Queue Agent")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  }, 15_000);
});
