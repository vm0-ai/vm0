import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadMarkReadContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { mockSubagentThread } from "./chat-test-helpers.ts";

const context = testContext();

function makeMsg(id: string, text: string): PagedChatMessage {
  return {
    id,
    role: "user",
    content: text,
    createdAt: "2026-05-01T00:00:00Z",
  };
}

describe("chat thread realtime catch-up", () => {
  it("drains all pending pages when fetching after a burst", async () => {
    const threadId = "catchup-thread";

    const baselineMessages = Array.from({ length: 5 }, (_, i) => {
      return makeMsg(`base-${i}`, `Baseline ${i}`);
    });

    const burstMessages = Array.from({ length: 120 }, (_, i) => {
      return makeMsg(`burst-${i}`, `Burst ${i}`);
    });

    let listAfterCallCount = 0;

    // mockSubagentThread sets up team list, agent, thread, and thread list
    // handlers. We then override the thread detail and messages handlers with
    // our pagination-aware versions.
    mockSubagentThread(threadId);

    server.use(
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: threadId,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (!query.sinceId) {
          return respond(200, {
            messages: baselineMessages,
            hasHistoryBefore: false,
          });
        }

        const startIdx = listAfterCallCount * 50;
        listAfterCallCount++;
        const chunk = burstMessages.slice(startIdx, startIdx + 50);
        return respond(200, { messages: chunk });
      }),
      mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
        return respond(200, { lastReadMessageId: null, changed: false });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    // Wait for initial page to render
    await waitFor(() => {
      expect(screen.getByText("Baseline 0")).toBeInTheDocument();
    });

    // Without the drain-loop fix, only one 50-message page is fetched and
    // the last burst message never appears. With the fix, all pages drain.
    await waitFor(() => {
      expect(screen.getByText("Burst 119")).toBeInTheDocument();
    }, {});

    // 120 messages → 3 pages (50 + 50 + 20). The last page has < 50 messages
    // so reachedEnd fires and the loop stops without a 4th call.
    // Without the drain-loop fix, only 1 call.
    expect(listAfterCallCount).toBe(3);
  });
});
