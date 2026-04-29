import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

const threadTitles = {
  "thread-main": "Main conversation",
  "thread-sidebar": "Sidebar conversation",
  "thread-third": "Third conversation",
  "thread-fourth": "Fourth conversation",
} as const;

const threadMessages = {
  "thread-main": "Primary thread answer",
  "thread-sidebar": "Sidebar thread answer",
  "thread-third": "Third thread answer",
  "thread-fourth": "Fourth thread answer",
} as const;

type ThreadId = keyof typeof threadTitles;

function isThreadId(value: string): value is ThreadId {
  return value in threadTitles;
}

function mockChatSidebarApis(): void {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        threads: Object.entries(threadTitles).map(([id, title]) => {
          return {
            id,
            title,
            agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: false,
            isArchived: false,
            running: false,
          };
        }),
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      const id = String(params.id);
      if (!isThreadId(id)) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, {
        id,
        title: threadTitles[id],
        agentId: DEFAULT_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        lastReadMessageId: null,
        activeRunIds: [],
        activeRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ params, query, respond }) => {
      const id = String(params.threadId);
      if (!isThreadId(id)) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      if (query.sinceId) {
        return respond(200, { messages: [], hasHistoryBefore: false });
      }
      return respond(200, {
        messages: [
          {
            id: `${id}-message`,
            role: "assistant",
            content: threadMessages[id],
            createdAt: "2026-03-10T00:00:00Z",
          },
        ],
        hasHistoryBefore: false,
      });
    }),
    mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadMessageId: null, changed: false });
    }),
  );
}

function chatThreadLink(title: string): HTMLAnchorElement {
  const threadId = Object.entries(threadTitles).find(([, value]) => {
    return value === title;
  })?.[0];
  expect(threadId).toBeDefined();
  const link = document.querySelector<HTMLAnchorElement>(
    `a[data-chat-thread-id="${threadId}"]`,
  );
  expect(link).not.toBeNull();
  return link!;
}

function chatThreadContainer(threadId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  expect(element).not.toBeNull();
  return element!;
}

function fireModShiftArrow(
  threadId: string,
  key: "ArrowUp" | "ArrowDown",
): void {
  fireEvent.keyDown(chatThreadContainer(threadId), {
    key,
    ctrlKey: true,
    shiftKey: true,
  });
}

describe("chat sidebar", () => {
  it("uses normal clicks for the main chat and keeps the sidebar open", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Third conversation"));

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-third");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(screen.getByText("Third thread answer")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });
  });

  it("opens a chat sidebar on option-click without changing the main chat path", async () => {
    mockChatSidebarApis();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    detachedSetupPage({ context, path: "/chats/thread-main" });

    await waitFor(() => {
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Sidebar conversation"), { altKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();

    fireEvent.click(chatThreadLink("Sidebar conversation"), { altKey: true });

    await waitFor(() => {
      expect(search()).toBe("");
      expect(
        document.querySelector(
          '[data-chat-thread-container-id="thread-sidebar"]',
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("shows pane icons in highlighted sidebar chat titles only while two chats are open", async () => {
    mockChatSidebarApis();

    detachedSetupPage({ context, path: "/chats/thread-main" });

    await waitFor(() => {
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-thread-list-pane-icon-main"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-thread-list-pane-icon-sidebar"),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Sidebar conversation"), { altKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(
        within(chatThreadLink("Main conversation")).getByTestId(
          "chat-thread-list-pane-icon-main",
        ),
      ).toBeInTheDocument();
      expect(
        within(chatThreadLink("Sidebar conversation")).getByTestId(
          "chat-thread-list-pane-icon-sidebar",
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows thread titles after the agent name in chat headers while two chats are open", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(
        within(chatThreadContainer("thread-main")).getByText(
          "Main conversation",
        ),
      ).toHaveClass("truncate");
      expect(
        within(chatThreadContainer("thread-sidebar")).getByText(
          "Sidebar conversation",
        ),
      ).toHaveClass("truncate");
    });
  });

  it("does nothing when option-clicking the currently open main chat", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Main conversation"), { altKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(chatThreadContainer("thread-main")).toBeInTheDocument();
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });
  });

  it("highlights the sidebar query thread and ignores normal clicks on highlighted chats", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
      expect(chatThreadLink("Main conversation")).toHaveClass("bg-gray-200");
      expect(chatThreadLink("Sidebar conversation")).toHaveClass("bg-gray-200");
    });

    fireEvent.click(chatThreadLink("Sidebar conversation"));

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(chatThreadContainer("thread-main")).toBeInTheDocument();
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Main conversation"));

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(chatThreadContainer("thread-main")).toBeInTheDocument();
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
    });
  });

  it("switches and closes the existing sidebar with option-click", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Third conversation"), { altKey: true });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-third");
      expect(screen.getByText("Third thread answer")).toBeInTheDocument();
      expect(
        screen.queryByText("Sidebar thread answer"),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(chatThreadLink("Third conversation"), { altKey: true });

    await waitFor(() => {
      expect(search()).toBe("");
      expect(
        document.querySelector(
          '[data-chat-thread-container-id="thread-third"]',
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("restores the chat sidebar from the sidebar query param", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Sidebar thread answer")).toBeInTheDocument();
    });
  });

  it("uses main-pane shortcuts to switch the main thread while skipping the sidebar thread", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-main?sidebar=thread-sidebar",
    });

    await waitFor(() => {
      expect(chatThreadContainer("thread-main")).toBeInTheDocument();
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
    });

    fireModShiftArrow("thread-main", "ArrowDown");

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-third");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(screen.getByText("Third thread answer")).toBeInTheDocument();
    });

    fireModShiftArrow("thread-third", "ArrowUp");

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-main");
      expect(search()).toBe("?sidebar=thread-sidebar");
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
    });
  });

  it("uses sidebar-pane shortcuts to switch the sidebar while skipping the main thread", async () => {
    mockChatSidebarApis();

    detachedSetupPage({
      context,
      path: "/chats/thread-sidebar?sidebar=thread-third",
    });

    await waitFor(() => {
      expect(chatThreadContainer("thread-sidebar")).toBeInTheDocument();
      expect(chatThreadContainer("thread-third")).toBeInTheDocument();
    });

    fireModShiftArrow("thread-third", "ArrowUp");

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-sidebar");
      expect(search()).toBe("?sidebar=thread-main");
      expect(screen.getByText("Primary thread answer")).toBeInTheDocument();
    });

    fireModShiftArrow("thread-main", "ArrowDown");

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-sidebar");
      expect(search()).toBe("?sidebar=thread-third");
      expect(screen.getByText("Third thread answer")).toBeInTheDocument();
    });
  });
});
