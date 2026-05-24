import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs() {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse([
          {
            id: "thread-abc-123",
            title: "Test conversation",
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              avatarUrl: null,
            },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: false,
            running: false,
          },
        ]),
      );
    }),
    mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      return respond(200, {
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
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "thread-abc-123",
        title: "Test conversation",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-1",
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
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
