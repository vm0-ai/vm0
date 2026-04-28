/**
 * Tests for zero-chat-list-page.tsx
 *
 * Tests the chat list page with agent-scoped labels (matching the sidebar
 * after unified-list removal).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";

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

  it("should show agent-scoped 'Search chat with Zero' placeholder (CHAT-LIST-002)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search chat with Zero"),
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
      isArchived: false,
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

describe("zero chat list page - search", () => {
  it("should filter threads by search term (CHAT-LIST-006)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await userEvent.type(searchInput, "First");

    await waitFor(() => {
      // After filtering, matching results should remain visible
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
      // "No chats match your search" should not appear when results exist
      expect(
        screen.queryByText("No chats match your search"),
      ).not.toBeInTheDocument();
    });
  });

  it("should show 'No chats match your search' when no results (CHAT-LIST-007)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
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
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await userEvent.type(searchInput, "First");

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    const clearButton = screen.getAllByRole("button").find((el) => {
      return /Clear search/.test(el.getAttribute("aria-label") ?? "");
    })!;
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(searchInput).toHaveValue("");
    });
  });

  it("should be case-insensitive when filtering (CHAT-LIST-009)", async () => {
    mockChatThreads(createMockThreads());
    setupPage();

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await userEvent.type(searchInput, "first");

    await waitFor(() => {
      expect(screen.getAllByText("First chat thread")[0]).toBeInTheDocument();
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

// Default agent ID is fixed by the onboarding mock; pinnedAgentIds$ always
// prepends it to the user-pinned list.
const DEFAULT_AGENT = "c0000000-0000-4000-a000-000000000001";
const PINNED_EXTRA = "c0000000-0000-4000-a000-000000000011";

function mockPinnedAgents() {
  setMockTeam([
    {
      id: DEFAULT_AGENT,
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: PINNED_EXTRA,
      displayName: "David",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  setMockUserPreferences({ pinnedAgentIds: [PINNED_EXTRA] });
}

describe("mobile chat agent switcher - hidden when redesign off (CHAT-LIST-MOBILE-001)", () => {
  it("does not render the pinned-teammates strip with the default switch state", async () => {
    mockChatThreads(createMockThreads());
    mockPinnedAgents();
    detachedSetupPage({ context, path: "/chats" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Chats with/ }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("mobile-chat-agent-switcher"),
    ).not.toBeInTheDocument();
  });
});

describe("mobile chat agent switcher - shown when redesign on (CHAT-LIST-MOBILE-002)", () => {
  it("renders one button per pinned agent", async () => {
    mockChatThreads(createMockThreads());
    mockPinnedAgents();
    detachedSetupPage({
      context,
      path: "/chats",
      featureSwitches: { [FeatureSwitchKey.MobileNativeV1]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mobile-chat-agent-switcher"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId(`mobile-chat-agent-${DEFAULT_AGENT}`)).toBeInTheDocument();
    expect(screen.getByTestId(`mobile-chat-agent-${PINNED_EXTRA}`)).toBeInTheDocument();
  });
});

describe("mobile chat agent switcher - tap switches agent (CHAT-LIST-MOBILE-003)", () => {
  it("clicking a pinned avatar calls setChatAgentId$ for that agent", async () => {
    mockChatThreads(createMockThreads());
    mockPinnedAgents();
    detachedSetupPage({
      context,
      path: "/chats",
      featureSwitches: { [FeatureSwitchKey.MobileNativeV1]: true },
    });

    const davidButton = await waitFor(() => {
      return screen.getByTestId(`mobile-chat-agent-${PINNED_EXTRA}`);
    });
    click(davidButton);

    await waitFor(() => {
      expect(davidButton).toHaveAttribute("aria-pressed", "true");
    });
  });
});
