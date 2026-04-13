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
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PINNED_AGENT_ID = "agent-pinned-id";

function makeThread(
  id: string,
  title: string,
  createdAt: string,
): {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id,
    title,
    agentId: DEFAULT_AGENT_ID,
    createdAt,
    updatedAt: createdAt,
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
    agentId: string;
    createdAt: string;
    updatedAt: string;
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

  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json(agents);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads });
    }),
    http.get("*/api/zero/agents/:id", ({ params }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string | null;
          ownerId: string;
          description: string | null;
          sound: null;
          avatarUrl: null;
          headVersionId: string;
          permissionPolicies: null;
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          permissionPolicies: null,
        },
        [PINNED_AGENT_ID]: {
          agentId: PINNED_AGENT_ID,
          ownerId: "test-user",
          displayName: "Research Agent",
          description: "A pinned sub-agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          permissionPolicies: null,
        },
      };
      const agent = agents[params.id as string];
      if (!agent) {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }
      return HttpResponse.json(agent);
    }),
  );
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
  vi.clearAllMocks();
});

describe("zero sidebar - account dropdown opens (SIDEBAR-D-013)", () => {
  it("shows a dropdown menu with sign-out option when account trigger is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    await user.click(accountTrigger);

    await waitFor(() => {
      expect(screen.getByText("Sign out")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - sign-out option works (SIDEBAR-D-014)", () => {
  it("calls clerk signOut and closes the dropdown when sign-out is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    await user.click(accountTrigger);

    const signOutItem = await waitFor(() => {
      return screen.getByText("Sign out");
    });
    await user.click(signOutItem);

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
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const searchChatsBtn1 = screen.getByLabelText("Search chats");
    await user.click(searchChatsBtn1);

    const searchInput = screen.getByPlaceholderText(/Search chat with/);
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
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });

    const searchChatsBtn2 = screen.getByLabelText("Search chats");
    await user.click(searchChatsBtn2);

    const searchInput = screen.getByPlaceholderText(/Search chat with/);
    await user.type(searchInput, "First");

    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();

    const closeSearchBtn = screen.getByLabelText("Close search");
    await user.click(closeSearchBtn);

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - new chat button creates session (SIDEBAR-D-017)", () => {
  it("creates a new chat session and navigates to it", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();

    server.use(
      http.post("*/api/zero/chat-threads", () => {
        return HttpResponse.json(
          {
            id: "new-thread-id",
            title: null,
            agentId: DEFAULT_AGENT_ID,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
          { status: 201 },
        );
      }),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "new-thread-id",
          title: null,
          agentId: DEFAULT_AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          unsavedRuns: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Start on /agents so the new chat button triggers thread creation (not route navigation)
    detachedSetupPage({ context, path: "/agents" });

    const newChatButton = await waitFor(() => {
      return screen.getByLabelText("New chat with Zero");
    });

    await user.click(newChatButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });
});

describe("zero sidebar - delete thread button shows confirmation (SIDEBAR-D-018)", () => {
  it("shows a confirmation dialog when the delete button is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({
      threads: [makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z")],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByLabelText("Delete chat");
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Delete chat?")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - confirm delete removes thread (SIDEBAR-D-019)", () => {
  it("removes the thread from the list after confirming deletion", async () => {
    const user = userEvent.setup();

    let threads = [
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ];

    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([makeDefaultAgent()]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads });
      }),
      http.get("*/api/zero/chat-threads/:id", ({ params }) => {
        const thread = threads.find((t) => {
          return t.id === params.id;
        });
        return HttpResponse.json({
          id: params.id,
          title: thread?.title ?? null,
          agentId: DEFAULT_AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          unsavedRuns: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.delete("*/api/zero/chat-threads/:id", ({ params }) => {
        threads = threads.filter((t) => {
          return t.id !== params.id;
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByLabelText("Delete chat");
    await user.click(deleteButtons[0]);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });

    const confirmButton = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return el.textContent?.trim() === "Delete";
      });
    expect(confirmButton).toBeDefined();
    await user.click(confirmButton!);

    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });
});

describe("zero sidebar - agent card toggles chat list (SIDEBAR-D-020)", () => {
  it("hides pinned agent cards when the Pinned header is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    const pinnedHeader = screen.getByTestId("pinned-section-header");
    await user.click(pinnedHeader);

    await waitFor(() => {
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });
  });
});

describe("zero sidebar - sidebar collapse button hides sidebar (SIDEBAR-D-022)", () => {
  it("collapses the sidebar and shows expand button when collapse is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const collapseBtn = screen.getByLabelText("Collapse sidebar");
    await user.click(collapseBtn);

    await waitFor(() => {
      expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - collapse button closes mobile overlay (SIDEBAR-M-023)", () => {
  it("sets sidebarExpanded to false when collapse button is clicked while sidebar is open as mobile overlay", async () => {
    const user = userEvent.setup();
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
    await user.click(collapseBtn);

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
