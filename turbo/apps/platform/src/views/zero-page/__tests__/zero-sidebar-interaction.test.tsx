/**
 * Interaction tests for ZeroSidebar component.
 *
 * Tests cover account dropdown, search, new chat creation, thread deletion,
 * agent card toggle, manage pinned dialog, sidebar collapse, and agent action menu.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  sidebarExpanded$,
  setSidebarExpanded$,
} from "../../../signals/zero-page/zero-nav.ts";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";
import { zeroAgentsByIdContract } from "@vm0/core/contracts/zero-agents";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PINNED_AGENT_ID = "agent-pinned-id";

function makeThread(
  id: string,
  title: string,
  createdAt: string,
): {
  id: string;
  title: string;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
  running: boolean;
} {
  return {
    id,
    title,
    agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
    createdAt,
    updatedAt: createdAt,
    isRead: false,
    isArchived: false,
    running: false,
  };
}

function makeDefaultAgent() {
  return {
    id: DEFAULT_AGENT_ID,
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makePinnedAgent() {
  return {
    id: PINNED_AGENT_ID,
    displayName: "Research Agent",
    description: "A pinned sub-agent",
    sound: null,
    avatarUrl: null,
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function mockBaseAPIs(options?: {
  threads?: {
    id: string;
    title: string;
    agent: { id: string; avatarUrl: string | null };
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    isArchived: boolean;
    running: boolean;
  }[];
  agents?: {
    id: string;
    displayName: string | null;
    description: string | null;
    sound: null;
    avatarUrl: null;
    headVersionId: string;
    updatedAt: string;
  }[];
}) {
  const agents = options?.agents ?? [makeDefaultAgent()];
  const threads = options?.threads ?? [];

  setMockTeam(agents);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string | null;
          ownerId: string;
          description: string | null;
          sound: null;
          avatarUrl: null;
          permissionPolicies: null;
          customSkills: string[];
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        [PINNED_AGENT_ID]: {
          agentId: PINNED_AGENT_ID,
          ownerId: "test-user",
          displayName: "Research Agent",
          description: "A pinned sub-agent",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
      };
      const agent = agents[params.id];
      if (!agent) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, agent);
    }),
  );
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
  vi.clearAllMocks();
});

describe("zero sidebar - account dropdown opens (SIDEBAR-D-013)", () => {
  it("shows a dropdown menu with sign-out option when account trigger is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    click(accountTrigger);

    await waitFor(() => {
      expect(screen.getByText("Sign out")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - sign-out option works (SIDEBAR-D-014)", () => {
  it("calls clerk signOut and closes the dropdown when sign-out is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    click(accountTrigger);

    const signOutItem = await waitFor(() => {
      return screen.getByText("Sign out");
    });
    click(signOutItem);

    expect(mockedClerk.signOut).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    });
  });
});

describe("zero sidebar - search input accepts text (SIDEBAR-D-015)", () => {
  it("receives focus and accepts typed text in the search input", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({
      threads: [makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z")],
    });
    detachedSetupPage({
      context,
      path: "/",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const searchChatsBtn1 = screen.getByLabelText("Search chats");
    click(searchChatsBtn1);

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await user.type(searchInput, "hello");

    expect(searchInput).toHaveValue("hello");
  });
});

describe("zero sidebar - clear search button resets search (SIDEBAR-D-016)", () => {
  it("clears the search field and restores the full thread list", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({
      threads: [
        makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
        makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
      ],
    });
    detachedSetupPage({
      context,
      path: "/",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });

    const searchChatsBtn2 = screen.getByLabelText("Search chats");
    click(searchChatsBtn2);

    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await user.type(searchInput, "First");

    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();

    const closeSearchBtn = screen.getByLabelText("Close search");
    click(closeSearchBtn);

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - new chat button creates session (SIDEBAR-D-017)", () => {
  it("creates a new chat session and navigates to it", async () => {
    mockBaseAPIs();

    server.use(
      mockApi(chatThreadsContract.create, ({ respond }) => {
        return respond(201, {
          id: "new-thread-id",
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "new-thread-id",
          title: null,
          agentId: DEFAULT_AGENT_ID,
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

    // Start on the default agent chat page so currentChatAgentId$ resolves before we click
    detachedSetupPage({
      context,
      path: `/agents/${DEFAULT_AGENT_ID}/chat`,
    });

    // Wait for the sidebar to finish loading (empty state confirms threads loaded
    // and the default agent id has resolved)
    const newChatButton = await waitFor(() => {
      expect(
        screen.getByText("Start a conversation and it'll show up here"),
      ).toBeInTheDocument();
      return screen.getByLabelText("New chat with Zero");
    });

    click(newChatButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });
});

describe("zero sidebar - delete thread button shows confirmation (SIDEBAR-D-018)", () => {
  it("shows a confirmation dialog when the delete button is clicked", async () => {
    mockBaseAPIs({
      threads: [makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z")],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByLabelText("Delete chat");
    click(deleteButtons[0]);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Delete chat?")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - confirm delete removes thread (SIDEBAR-D-019)", () => {
  it("removes the thread from the list after confirming deletion", async () => {
    let threads = [
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ];

    setMockTeam([makeDefaultAgent()]);
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, { threads });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        const thread = threads.find((t) => {
          return t.id === params.id;
        });
        return respond(200, {
          id: params.id,
          title: thread?.title ?? null,
          agentId: DEFAULT_AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(chatThreadByIdContract.delete, ({ params, respond }) => {
        threads = threads.filter((t) => {
          return t.id !== params.id;
        });
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByLabelText("Delete chat");
    click(deleteButtons[0]);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });

    const confirmButton = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return el.textContent?.trim() === "Delete";
      });
    expect(confirmButton).toBeDefined();
    click(confirmButton!);

    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });
});

describe("zero sidebar - agent card toggles chat list (SIDEBAR-D-020)", () => {
  it("hides pinned agent cards when the Pinned header is clicked", async () => {
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    const pinnedHeader = screen.getByTestId("pinned-section-header");
    click(pinnedHeader);

    await waitFor(() => {
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });
  });
});

describe("zero sidebar - sidebar collapse button hides sidebar (SIDEBAR-D-022)", () => {
  it("collapses the sidebar and shows expand button when collapse is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const collapseBtn = screen.getByLabelText("Collapse sidebar");
    click(collapseBtn);

    await waitFor(() => {
      expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - collapse button closes mobile overlay (SIDEBAR-M-023)", () => {
  it("sets sidebarExpanded to false when collapse button is clicked while sidebar is open as mobile overlay", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    // Simulate mobile sidebar expanded state (as if "Open menu" was tapped)
    context.store.set(setSidebarExpanded$, true);

    expect(context.store.get(sidebarExpanded$)).toBeTruthy();

    const collapseBtn = screen.getByLabelText("Collapse sidebar");
    click(collapseBtn);

    expect(context.store.get(sidebarExpanded$)).toBeFalsy();
  });
});

describe("zero sidebar - agent action menu opens (SIDEBAR-D-066)", () => {
  it("reveals the remove action button on a pinned agent card", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    // The "Remove from list" button is revealed via CSS on hover
    const removeButton = screen.getByLabelText("Remove from list");
    await user.hover(removeButton);
    expect(removeButton).toBeVisible();
  });
});
