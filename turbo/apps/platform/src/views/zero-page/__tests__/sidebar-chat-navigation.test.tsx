import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "mock-compose-id",
            name: "zero",
            displayName: null,
            description: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
            isOwner: true,
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: [
          {
            id: "thread-abc-123",
            title: "Test conversation",
            preview: "Who are you and what can you do?",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-abc-123",
        title: "Test conversation",
        agentId: "mock-compose-id",
        chatMessages: [
          {
            role: "user",
            content: "Who are you?",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            role: "assistant",
            content: "I am Zero, your AI assistant.",
            createdAt: "2026-03-10T00:00:01Z",
          },
        ],
        latestSessionId: "session-1",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("sidebar chat navigation from /team", () => {
  it("should navigate from /team to chat session when clicking sidebar chat link", async () => {
    mockAPIs();
    await setupPage({ context, path: "/team" });

    // Verify team page is rendered
    await waitFor(() => {
      expect(screen.getByText(/team/i, { selector: "h1" })).toBeInTheDocument();
    });

    // Find and click the chat thread in sidebar
    const chatLink = await waitFor(() =>
      screen.getByText("Who are you and what can you do?"),
    );
    const anchor = chatLink.closest("a");
    expect(anchor).not.toBeNull();
    await act(() => {
      anchor!.click();
    });

    // After clicking, the chat page content should render (not team page)
    await waitFor(() => {
      expect(screen.getByText("Who are you?")).toBeInTheDocument();
    });
  });
});
