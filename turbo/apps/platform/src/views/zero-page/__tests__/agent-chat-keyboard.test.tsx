import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const AGENT_ID = "agent-alpha";

function mockAgent() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: AGENT_ID,
          displayName: "Alpha Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
  );
}

function mockThreadList(threads: { id: string; title: string }[]) {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: threads.map((t) => {
          return {
            id: t.id,
            title: t.title,
            agentId: AGENT_ID,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            isArchived: false,
          };
        }),
      });
    }),
  );
}

function mockEmptyMessages(threadId: string) {
  server.use(
    http.get(`*/api/zero/chat-threads/${threadId}/messages`, () => {
      return HttpResponse.json({ messages: [], hasMore: false });
    }),
    http.get(`*/api/zero/chat-threads/${threadId}`, () => {
      return HttpResponse.json({
        id: threadId,
        title: `Thread ${threadId}`,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("agent chat page keyboard shortcuts", () => {
  it("mod+shift+down navigates to the first thread", async () => {
    const user = userEvent.setup();
    mockAgent();
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
