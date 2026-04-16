import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";

const context = testContext();

describe("chat session switch", () => {
  it("should show running state when switching to a session with an active run", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", ({ params }) => {
        const id = params.id as string;
        if (id === "thread-completed") {
          return HttpResponse.json({
            id: "thread-completed",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [
              {
                role: "user",
                content: "Done task",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                role: "assistant",
                content: "All done!",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }
        // thread-running
        return HttpResponse.json({
          id: "thread-running",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "Active task prompt",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: null,
              runId: "run-active",
              status: "running",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json({
          id: "a0000000-0000-4000-a000-000000000099",
          sessionId: "session-1",
          agentId: "zero",
          displayName: null,
          framework: "claude-code",
          modelProvider: null,
          selectedModel: null,
          triggerSource: "web",
          triggerAgentName: null,
          scheduleId: null,
          status: "running",
          prompt: "Active task prompt",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-03-10T00:00:00Z",
          startedAt: "2026-03-10T00:00:01Z",
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/zero/runs/:id/telemetry/agent", () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      }),
      http.get("*/api/zero/queue-position", () => {
        return HttpResponse.json({ position: 0 });
      }),
    );

    // Start on a completed thread (no active polling)
    detachedSetupPage({ context, path: "/chats/thread-completed" });

    await waitFor(() => {
      expect(screen.getByText("All done!")).toBeInTheDocument();
    });

    // No Stop button should be present
    expect(screen.queryByLabelText("Stop")).toBeNull();

    // Navigate to the running thread
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-running" },
    });

    // The running thread should show the thinking/shimmer state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Stop button should appear for the active run
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  it("should load different messages when switching between completed sessions", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", ({ params }) => {
        const id = params.id as string;
        return HttpResponse.json({
          id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: `Question for ${id}`,
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: `Answer for ${id}`,
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/session-alpha" });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-alpha")).toBeInTheDocument();
    });

    // Switch to session-beta
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "session-beta" },
    });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-beta")).toBeInTheDocument();
    });

    // Previous session content should be gone
    expect(screen.queryByText("Answer for session-alpha")).toBeNull();

    // Switch to session-gamma
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "session-gamma" },
    });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-gamma")).toBeInTheDocument();
    });

    // Only current session content visible
    expect(screen.queryByText("Answer for session-beta")).toBeNull();
  });
});
