import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: [
          {
            id: "thread-abc-123",
            title: "Test conversation",
            agentId: "c0000000-0000-4000-a000-000000000001",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: false,
            isArchived: false,
            running: false,
          },
        ],
      });
    }),
    http.get(
      "*/api/zero/chat-threads/thread-abc-123/messages",
      ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("sinceId")) {
          return HttpResponse.json({ messages: [], hasMore: false });
        }
        return HttpResponse.json({
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Who are you?",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-2",
              role: "assistant",
              content: "I am Zero, your AI assistant.",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
          hasMore: false,
        });
      },
    ),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-abc-123",
        title: "Test conversation",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-1",
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("sidebar chat navigation from /team", () => {
  it("should navigate from /team to chat session when clicking sidebar chat link", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents" });

    // Verify agents page is rendered
    await waitFor(() => {
      expect(
        screen.getByText(/agents/i, { selector: "h1" }),
      ).toBeInTheDocument();
    });

    // Find and click the chat thread in sidebar
    const chatLink = await waitFor(() => {
      return screen.getByText("Test conversation");
    });
    const anchor = chatLink.closest("a");
    expect(anchor).not.toBeNull();
    await act(() => {
      anchor!.click();
    });

    // After clicking, the URL should navigate to the chat page
    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-abc-123");
    });
  });
});
