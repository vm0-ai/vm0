import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "agent-alpha";
function mockThreadList(threads: { id: string; title: string }[]) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        threads: threads.map((t) => {
          return {
            id: t.id,
            title: t.title,
            agentId: AGENT_ID,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            isArchived: false,
            running: false,
          };
        }),
      });
    }),
  );
}

function mockEmptyMessages(threadId: string) {
  server.use(
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: `Thread ${threadId}`,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("agent chat page keyboard shortcuts", () => {
  it("mod+shift+down navigates to the first thread", async () => {
    const user = userEvent.setup();
    mockThreadList([
      { id: "thread-1", title: "First" },
      { id: "thread-2", title: "Second" },
    ]);
    mockEmptyMessages("thread-1");
    mockEmptyMessages("thread-2");

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(screen.getByTestId("chat-tagline")).toBeInTheDocument();
    });

    await user.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-1");
    });
  });
});
