import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/core";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { server } from "../../../mocks/server.ts";
import { hasSubscription } from "../../../mocks/ably.ts";
import { pathname, search } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const FIRST_MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

function mockThreadPage(
  threadId: string,
  messages: PagedChatMessage[],
  lastReadMessageId: string | null,
) {
  let markReadCount = 0;

  server.use(
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: null,
        agentId: DEFAULT_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        lastReadMessageId,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-04-25T00:00:00Z",
        updatedAt: "2026-04-25T00:00:00Z",
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages, hasHistoryBefore: false });
    }),
    mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
      markReadCount++;
      return respond(200, {
        lastReadMessageId: messages.at(-1)?.id ?? null,
        changed: markReadCount === 1,
      });
    }),
  );

  return {
    get markReadCount() {
      return markReadCount;
    },
  };
}

describe("chat page setup", () => {
  it("redirects missing chat threads through the home route", async () => {
    server.use(
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/123?source=legacy",
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
      expect(search()).toBe("");
    });
  });

  it("does not mark empty chat threads as read", async () => {
    const threadId = "empty-read-thread";
    const tracker = mockThreadPage(threadId, [], null);

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadMessageCreated:${threadId}`),
      ).toBeTruthy();
    });

    expect(tracker.markReadCount).toBe(0);
  });

  it("skips mark-read when the latest loaded message is already read", async () => {
    const threadId = "already-read-thread";
    const tracker = mockThreadPage(
      threadId,
      [
        {
          id: FIRST_MESSAGE_ID,
          role: "user",
          content: "Already read",
          createdAt: "2026-04-25T00:00:00Z",
        },
      ],
      FIRST_MESSAGE_ID,
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadMessageCreated:${threadId}`),
      ).toBeTruthy();
    });

    expect(tracker.markReadCount).toBe(0);
  });

  it("marks a thread as read when the latest loaded message changes", async () => {
    const threadId = "changed-read-thread";
    const tracker = mockThreadPage(
      threadId,
      [
        {
          id: FIRST_MESSAGE_ID,
          role: "user",
          content: "Unread",
          createdAt: "2026-04-25T00:00:00Z",
        },
      ],
      null,
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(tracker.markReadCount).toBe(1);
    });
  });
});
