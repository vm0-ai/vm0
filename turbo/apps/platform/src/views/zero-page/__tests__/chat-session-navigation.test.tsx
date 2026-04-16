import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockChatSessionAPIs() {
  server.use(
    http.get(
      "*/api/zero/chat-threads/session-thread-1/messages",
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
              content: "Run the task",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-2",
              role: "assistant",
              content: "Task is running.",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
          hasMore: false,
        });
      },
    ),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "session-thread-1",
        title: "Session navigation test",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-wrapper-1",
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("chat session page wrapper navigation", () => {
  it("should navigate to agent profile when clicking chat avatar", async () => {
    const user = userEvent.setup();
    mockChatSessionAPIs();

    detachedSetupPage({ context, path: "/chats/session-thread-1" });

    // Wait for chat messages to render
    await waitFor(() => {
      expect(screen.getByText("Task is running.")).toBeInTheDocument();
    });

    // Click the avatar button in the session header
    const avatarButton = screen.getByLabelText("View agent profile");
    await user.click(avatarButton);

    // Verify navigation to /team/c0000000-0000-4000-a000-000000000001 (no tab param)
    await waitFor(() => {
      expect(pathname()).toBe("/agents/c0000000-0000-4000-a000-000000000001");
    });
  });
});
