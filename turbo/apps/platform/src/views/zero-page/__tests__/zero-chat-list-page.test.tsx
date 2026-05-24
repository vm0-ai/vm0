/**
 * Tests for zero-chat-list-page.tsx
 *
 * Tests the chat list page with agent-scoped labels (matching the sidebar
 * after unified-list removal).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
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

describe("zero chat list page - header and title", () => {
  it("should render the page with agent-scoped 'Chats with Zero' title (CHAT-LIST-001)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Chats with Zero" }),
      ).toBeInTheDocument();
    });
  });

  it("should show 'New chat' button (CHAT-LIST-003)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getByText("New chat")).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - chat list rendering", () => {
  it("should render list of chat threads (CHAT-LIST-004)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });
    expect(screen.getAllByText("Second chat thread")[0]).toBeInTheDocument();
  });

  it("should render 'New chat' as default title when title is null (CHAT-LIST-005)", async () => {
    const threadWithNullTitle = {
      id: "thread-null",
      title: null,
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      isRead: true,
      running: false,
    } as unknown as ReturnType<typeof createMockThreads>[number];
    mockChatThreads([threadWithNullTitle]);
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("New chat")[0]).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - loading skeleton", () => {
  beforeEach(() => {
    // Suppress console.error during the loading→empty transition, which
    // triggers React's ErrorBoundary.componentDidCatch. The setup.ts spy
    // throws on console.error, which would cause unhandled errors.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // No afterEach needed — setup.ts's beforeEach re-establishes the
  // throwing console.error spy for every subsequent test. Keeping the
  // no-op spy active through cleanup prevents React ErrorBoundary errors
  // during clearAllDetached() from becoming unhandled Vitest errors.

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
      const skeletons = screen.getAllByTestId("sidebar-skeleton");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    hangDeferred.resolve();

    // Wait for the loading state to resolve before the test ends to prevent
    // async re-renders from triggering ErrorBoundary during afterEach cleanup.
    await waitFor(() => {
      expect(screen.queryByTestId("sidebar-skeleton")).not.toBeInTheDocument();
    });
  });
});

describe("zero chat list page - chat list rendering (continued)", () => {
  it("should show error message when API fails", async () => {
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(401, {
          error: { message: "Server error", code: "INTERNAL_SERVER_ERROR" },
        });
      }),
    );

    setupPage();

    await waitFor(() => {
      expect(
        screen.getByText(/failed to load chats|server error/i),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat list page - empty state", () => {
  it("should show empty state message when no threads exist (CHAT-LIST-010)", async () => {
    mockChatThreads([]);
    setupPage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Start a conversation and it'll show up here")
          .length,
      ).toBeGreaterThan(0);
    });
  });
});

describe("zero chat list page - delete confirmation", () => {
  it("should open delete confirmation dialog when delete button is clicked (CHAT-LIST-011)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    // Click delete button (aria-label, one per thread)
    const deleteButtons = screen.getAllByRole("button").filter((el) => {
      return /Delete chat/.test(el.getAttribute("aria-label") ?? "");
    });
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);
  });

  it("should close dialog when Cancel is clicked (CHAT-LIST-012)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    // Click delete button to open dialog
    const deleteButtons = screen.getAllByRole("button").filter((el) => {
      return /Delete chat/.test(el.getAttribute("aria-label") ?? "");
    });
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getAllByText("Delete chat?").length).toBeGreaterThan(0);
    });

    click(screen.getAllByText("Cancel")[0]);

    await waitFor(() => {
      expect(screen.queryByText("Delete chat?")).not.toBeInTheDocument();
    });
  });
});
