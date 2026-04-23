import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

function mockChatSessionAPIs() {
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
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "session-thread-1",
        title: "Session navigation test",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-wrapper-1",
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
  );
}

describe("chat session page wrapper navigation", () => {
  it("should navigate to agent profile when clicking chat avatar", async () => {
    mockChatSessionAPIs();

    detachedSetupPage({ context, path: "/chats/session-thread-1" });

    // Wait for chat messages to render
    await waitFor(() => {
      expect(screen.getByText("Task is running.")).toBeInTheDocument();
    });

    // Click the avatar button in the session header
    const avatarButton = screen.getByLabelText("View agent profile");
    click(avatarButton);

    // Verify navigation to /team/c0000000-0000-4000-a000-000000000001 (no tab param)
    await waitFor(() => {
      expect(pathname()).toBe("/agents/c0000000-0000-4000-a000-000000000001");
    });
  });
});
