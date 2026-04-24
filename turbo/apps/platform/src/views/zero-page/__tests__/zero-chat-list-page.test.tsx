/**
 * Tests for zero-chat-list-page.tsx
 *
 * Tests the chat list page with unified labels (after graduate unified chat
 * labels as permanent default, removing per-agent avatar display from header
 * and thread items).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";
import { zeroTeamContract } from "@vm0/core/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/core/contracts/zero-agents";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const mockApi = createMockApi(context);

function createMockThreads(overrides = {}) {
  return [
    {
      id: "thread-1",
      title: "First chat thread",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      isRead: true,
      isArchived: false,
      running: false,
      ...overrides,
    },
    {
      id: "thread-2",
      title: "Second chat thread",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
      ...overrides,
    },
  ];
}

function mockChatThreads(threads: ReturnType<typeof createMockThreads>) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
  );
}

function setupPage() {
  detachedSetupPage({
    context,
    path: "/chats",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zero chat list page - header and title", () => {
  it("should render the page with unified 'Chats' title (CHAT-LIST-001)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    });
  });

  it("should show unified 'Search chats' placeholder (CHAT-LIST-002)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search chats"),
      ).toBeInTheDocument();
    });
  });

  it("should show 'New chat' button (CHAT-LIST-003)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - chat list rendering", () => {
  it("should render list of chat threads (CHAT-LIST-004)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat thread")).toBeInTheDocument();
  });

  it("should render 'New chat' as default title when title is null (CHAT-LIST-005)", async () => {
    mockChatThreads(
      createMockThreads({ id: "thread-null", title: null }),
    );
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("New chat")).toBeInTheDocument();
    });
  });

  it("should show loading skeleton when threads are loading", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.list, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { threads: [] });
      }),
    );

    setupPage();

    await waitFor(() => {
      // Skeleton lines should appear
      const skeletons = screen.getAllByTestId(/skeleton/i);
      expect(skeletons.length).toBeGreaterThan(0);
    });

    hangDeferred.resolve();
  });

  it("should show error message when API fails", async () => {
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(500, { error: "Server error" });
      }),
    );

    setupPage();

    await waitFor(() => {
      expect(screen.getByText(/failed to load chats/i)).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - search", () => {
  it("should filter threads by search term (CHAT-LIST-006)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chats");
    await userEvent.type(searchInput, "First");

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
      expect(screen.queryByText("Second chat thread")).not.toBeInTheDocument();
    });
  });

  it("should show 'No chats match your search' when no results (CHAT-LIST-007)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chats");
    await userEvent.type(searchInput, "nonexistent");

    await waitFor(() => {
      expect(
        screen.getByText("No chats match your search"),
      ).toBeInTheDocument();
    });
  });

  it("should clear search when X button is clicked (CHAT-LIST-008)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chats");
    await userEvent.type(searchInput, "First");

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    const clearButton = screen.getByRole("button", { name: "Clear search" });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(searchInput).toHaveValue("");
    });
  });

  it("should be case-insensitive when filtering (CHAT-LIST-009)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chats");
    await userEvent.type(searchInput, "first");

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - empty state", () => {
  it("should show empty state message when no threads exist (CHAT-LIST-010)", async () => {
    mockChatThreads([]);
    setupPage();

    await waitFor(() => {
      expect(
        screen.getByText("Start a conversation and it'll show up here"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - delete confirmation", () => {
  it("should open delete confirmation dialog when delete button is clicked (CHAT-LIST-011)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    // Hover to reveal delete button
    const firstThread = screen.getByText("First chat thread");
    fireEvent.mouseEnter(firstThread);

    await waitFor(() => {
      const deleteButton = screen.getByRole("button", { name: "Delete chat" });
      expect(deleteButton).toBeVisible();
    });
  });

  it("should close dialog when Cancel is clicked (CHAT-LIST-012)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("First chat thread")).toBeInTheDocument();
    });

    // Hover to reveal delete button
    const firstThread = screen.getByText("First chat thread");
    fireEvent.mouseEnter(firstThread);

    await waitFor(() => {
      const deleteButton = screen.getByRole("button", { name: "Delete chat" });
      fireEvent.click(deleteButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Delete chat?")).toBeInTheDocument();
    });

    click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete chat?")).not.toBeInTheDocument();
    });
  });
});
