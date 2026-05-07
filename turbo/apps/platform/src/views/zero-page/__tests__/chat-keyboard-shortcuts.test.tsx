import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  chatThreadsContract,
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mainChatPane(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-chat-thread-container-id]",
  );
  expect(element).not.toBeNull();
  return element!;
}

function fireMainShortcut(
  key: "ArrowUp" | "ArrowDown",
  options?: { shiftKey?: boolean },
): void {
  fireEvent.keyDown(mainChatPane(), {
    key,
    ctrlKey: true,
    shiftKey: options?.shiftKey ?? false,
  });
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

function mockThreadList(threads: { id: string; title: string }[]) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        threads: threads.map((t) => {
          return {
            id: t.id,
            title: t.title,
            agent: { id: AGENT_ID, avatarUrl: null },
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

describe("chat page keyboard shortcuts", () => {
  it("mod+shift+down navigates to the next thread", async () => {
    mockThreadList([
      { id: "thread-1", title: "First" },
      { id: "thread-2", title: "Second" },
      { id: "thread-3", title: "Third" },
    ]);
    mockEmptyMessages("thread-1");
    mockEmptyMessages("thread-2");
    mockEmptyMessages("thread-3");

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(
        screen.getByText(/Send a message to start the conversation/i),
      ).toBeInTheDocument();
    });

    fireMainShortcut("ArrowDown", { shiftKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-2");
    });
  });

  it("mod+shift+up navigates to the previous thread", async () => {
    mockThreadList([
      { id: "thread-1", title: "First" },
      { id: "thread-2", title: "Second" },
      { id: "thread-3", title: "Third" },
    ]);
    mockEmptyMessages("thread-1");
    mockEmptyMessages("thread-2");
    mockEmptyMessages("thread-3");

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(
        screen.getByText(/Send a message to start the conversation/i),
      ).toBeInTheDocument();
    });

    fireMainShortcut("ArrowUp", { shiftKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-1");
    });
  });

  it("mod+shift+up on the first thread escapes to the agent chat page", async () => {
    mockThreadList([
      { id: "thread-1", title: "First" },
      { id: "thread-2", title: "Second" },
    ]);
    mockEmptyMessages("thread-1");
    mockEmptyMessages("thread-2");

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(
        screen.getByText(/Send a message to start the conversation/i),
      ).toBeInTheDocument();
    });

    fireMainShortcut("ArrowUp", { shiftKey: true });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
  });

  it("mod+shift+up on the first thread uses the list item's agent.id", async () => {
    // The escape navigation must use agent.id, not agentId.
    const AGENT_ID_FROM_OBJECT = "a2222222-0000-4000-a000-000000000002";
    // Include the thread's agent in the team so the chat page setup does not
    // treat it as missing and redirect to the default agent.
    setMockTeam([
      {
        id: AGENT_ID,
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: AGENT_ID_FROM_OBJECT,
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          threads: [
            {
              id: "thread-agent-obj",
              title: "With agent object",
              agent: { id: AGENT_ID_FROM_OBJECT, avatarUrl: null },
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
              isRead: true,
              isArchived: false,
              running: false,
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-agent-obj",
          title: "With agent object",
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
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-agent-obj" });

    await waitFor(() => {
      expect(
        screen.getByText(/Send a message to start the conversation/i),
      ).toBeInTheDocument();
    });

    fireMainShortcut("ArrowUp", { shiftKey: true });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID_FROM_OBJECT}/chat`);
    });
  });

  it("mod+shift+down is a no-op on the last thread", async () => {
    mockThreadList([
      { id: "thread-1", title: "First" },
      { id: "thread-2", title: "Second" },
    ]);
    mockEmptyMessages("thread-1");
    mockEmptyMessages("thread-2");

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(
        screen.getByText(/Send a message to start the conversation/i),
      ).toBeInTheDocument();
    });

    // At the last thread, mod+shift+down should no-op. Fire it, then fire
    // mod+shift+up which is expected to navigate to thread-1. If the first
    // shortcut had incorrectly navigated, the second navigation would end up
    // somewhere other than thread-1.
    fireMainShortcut("ArrowDown", { shiftKey: true });
    fireMainShortcut("ArrowUp", { shiftKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-1");
    });
  });

  it("mod+down scrolls the message list to the bottom", async () => {
    mockThreadList([{ id: "thread-scroll", title: "Scroll test" }]);
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
              content: "Scroll shortcut test",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-scroll",
          title: "Scroll test",
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

    detachedSetupPage({ context, path: "/chats/thread-scroll" });

    await waitFor(() => {
      expect(screen.getByText("Scroll shortcut test")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();

    // Patch scrollHeight to a non-zero value so scrollToBottom$ sets
    // scrollTop = scrollHeight. In JSDOM scrollHeight is always 0.
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => {
        return 1200;
      },
      configurable: true,
    });
    scrollContainer!.scrollTop = 0;
    fireMainShortcut("ArrowDown");

    await waitFor(() => {
      expect(scrollContainer!.scrollTop).toBe(1200);
    });
  });

  it("mod+up scrolls the message list to the top", async () => {
    mockThreadList([{ id: "thread-scroll-top", title: "Scroll top test" }]);
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
              content: "Scroll top shortcut test",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-scroll-top",
          title: "Scroll top test",
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

    detachedSetupPage({ context, path: "/chats/thread-scroll-top" });

    await waitFor(() => {
      expect(screen.getByText("Scroll top shortcut test")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();

    scrollContainer!.scrollTop = 500;
    fireMainShortcut("ArrowUp");

    await waitFor(() => {
      expect(scrollContainer!.scrollTop).toBe(0);
    });
  });

  it("plain up/down keys hand off to native message-list scrolling outside the composer", async () => {
    mockThreadList([{ id: "thread-arrow-scroll", title: "Arrow scroll test" }]);
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
              content: "Plain arrow scroll test",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-arrow-scroll",
          title: "Arrow scroll test",
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

    detachedSetupPage({ context, path: "/chats/thread-arrow-scroll" });

    await waitFor(() => {
      expect(screen.getByText("Plain arrow scroll test")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => {
        return 1200;
      },
      configurable: true,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });

    expect(fireEvent.keyDown(document, { key: "ArrowDown" })).toBeTruthy();
    expect(document.activeElement).toBe(scrollContainer);

    const activeBeforeUp = document.activeElement;
    expect(fireEvent.keyDown(document, { key: "ArrowUp" })).toBeTruthy();
    expect(document.activeElement).toBe(activeBeforeUp);

    const composer = document.querySelector("textarea");
    expect(composer).not.toBeNull();
    composer!.focus();
    fireEvent.keyDown(composer!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(composer);

    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    fireEvent.keyDown(outsideButton, { key: "ArrowDown" });
    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });
});
