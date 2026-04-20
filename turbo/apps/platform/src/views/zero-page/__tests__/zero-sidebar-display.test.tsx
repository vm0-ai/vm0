/**
 * Display tests for ZeroSidebar component.
 *
 * Tests cover chat thread list, loading/error states, search, agent cards,
 * active nav highlighting, pinned agents, Slack scope mismatch indicator,
 * and new chat button enabled/disabled states.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { chatThreadsContract, zeroIntegrationsSlackContract } from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockBaseAPIs(
  overrides: {
    threads?: {
      id: string;
      title: string;
      agentId: string;
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
  } = {},
) {
  const agents = overrides.agents ?? [
    {
      id: DEFAULT_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
  const threads = overrides.threads ?? [];

  setMockTeam(agents);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
});

describe("zero sidebar - chat thread list display (SIDEBAR-D-001)", () => {
  it("renders two chat threads in the sidebar", async () => {
    mockBaseAPIs({
      threads: [
        {
          id: "thread-1",
          title: "Deploy to production",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: false,
        },
        {
          id: "thread-2",
          title: "Fix the bug",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-09T00:00:00Z",
          updatedAt: "2026-03-09T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: false,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      expect(
        within(sidebar).getByText("Deploy to production"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Fix the bug")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - loading state (SIDEBAR-D-002)", () => {
  it("shows skeleton placeholders while chat threads are loading", async () => {
    const deferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.list, async ({ respond }) => {
        await deferred.promise;
        return respond(200, { threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/" });

    // While the chat-threads request is hanging, skeletons should be visible
    await waitFor(() => {
      const sidebar = getSidebar();
      expect(
        within(sidebar).getAllByTestId("sidebar-skeleton").length,
      ).toBeGreaterThan(0);
    });

    deferred.resolve();
  });
});

describe("zero sidebar - search results filter (SIDEBAR-D-003)", () => {
  it("shows only matching thread after typing a search term", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({
      threads: [
        {
          id: "thread-1",
          title: "Deploy to production",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: false,
        },
        {
          id: "thread-2",
          title: "Fix the bug",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-09T00:00:00Z",
          updatedAt: "2026-03-09T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: false,
        },
      ],
    });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Deploy to production"),
      ).toBeInTheDocument();
    });

    const searchChatsBtn1 = screen.getByLabelText("Search chats");
    await user.click(searchChatsBtn1);
    const searchInput = screen.getByPlaceholderText(/Search chat with/);
    await user.type(searchInput, "deploy");

    expect(
      within(getSidebar()).getByText("Deploy to production"),
    ).toBeInTheDocument();
    expect(
      within(getSidebar()).queryByText("Fix the bug"),
    ).not.toBeInTheDocument();
  });
});

describe("zero sidebar - search term displays in input (SIDEBAR-D-004)", () => {
  it("shows the typed search term in the search input", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({
      threads: [
        {
          id: "thread-1",
          title: "Deploy to production",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: false,
        },
      ],
    });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Deploy to production"),
      ).toBeInTheDocument();
    });

    const searchChatsBtn2 = screen.getByLabelText("Search chats");
    await user.click(searchChatsBtn2);
    const searchInput = screen.getByPlaceholderText(/Search chat with/);
    await user.type(searchInput, "deploy");

    expect(searchInput).toHaveValue("deploy");
  });
});

describe("zero sidebar - agent cards display (SIDEBAR-D-006)", () => {
  it("shows default agent and pinned sub-agent names in the sidebar", async () => {
    mockBaseAPIs({
      agents: [
        {
          id: DEFAULT_AGENT_ID,
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-research",
          displayName: "Research Agent",
          description: "Finds information",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ],
    });
    setMockUserPreferences({ pinnedAgentIds: ["agent-research"] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      // Default agent displays as "Zero" (or the raw id)
      expect(within(sidebar).getByText("Zero")).toBeInTheDocument();
      // Pinned sub-agent shows its displayName
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - active tab indicator (SIDEBAR-D-007)", () => {
  it("highlights the Agents nav link with aria-current=page when on /agents", async () => {
    mockBaseAPIs();

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      const nav = getSidebar();
      const agentsLink = within(nav)
        .getAllByRole("link")
        .find((el) => {
          return el.textContent?.trim() === "Agents";
        });
      expect(agentsLink).toBeDefined();
      expect(agentsLink).toHaveAttribute("aria-current", "page");
    });
  });
});

describe("zero sidebar - pinned agents display (SIDEBAR-D-008)", () => {
  it("shows the Pinned section header in the sidebar", async () => {
    mockBaseAPIs();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      expect(within(sidebar).getByText("Pinned")).toBeInTheDocument();
    });
  });

  it("shows pinned agent name once preferences resolve", async () => {
    mockBaseAPIs({
      agents: [
        {
          id: DEFAULT_AGENT_ID,
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-writer",
          displayName: "Writer Agent",
          description: "Creates content",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ],
    });
    setMockUserPreferences({ pinnedAgentIds: ["agent-writer"] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      expect(within(sidebar).getByText("Writer Agent")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - Slack scope mismatch indicator (SIDEBAR-D-009)", () => {
  it("shows the Where Zero works link when Slack scope mismatch is true", async () => {
    server.use(
      mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
        return respond(200, {
          isConnected: true,
          isInstalled: true,
          isAdmin: true,
          scopeMismatch: true,
          workspaceName: "Test Workspace",
          installUrl: null,
          connectUrl: null,
          reinstallUrl: null,
          agentOrgSlug: null,
          environment: {
            requiredSecrets: [],
            requiredVars: [],
            missingSecrets: [],
            missingVars: [],
          },
        });
      }),
    );
    mockBaseAPIs();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").find((el) => {
          return /Where Zero works/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });

    // The mismatch badge should be present in the sidebar
    expect(
      screen.getByTestId("slack-scope-mismatch-indicator"),
    ).toBeInTheDocument();
  });
});

describe("zero sidebar - new chat button enabled/disabled state (SIDEBAR-D-010)", () => {
  it("shows the new chat button as enabled when not creating a session", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const newChatButton = screen.getByLabelText(/New chat with/i);
      expect(newChatButton).not.toBeDisabled();
    });
  });

  it("disables the new chat button while a POST to chat-threads is in flight", async () => {
    const user = userEvent.setup();
    const deferred = createDeferredPromise<void>(context.signal);

    mockBaseAPIs();
    server.use(
      mockApi(chatThreadsContract.create, async ({ respond }) => {
        await deferred.promise;
        return respond(201, {
          id: "new-thread",
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByLabelText(/New chat with/i)).toBeDefined();
    });

    // Trigger new chat creation
    const newChatBtn = screen.getByLabelText(/New chat with/i);
    await user.click(newChatBtn);

    // Button should become disabled while POST is in flight
    await waitFor(() => {
      expect(screen.getByLabelText(/New chat with/i)).toBeDisabled();
    });

    deferred.resolve();
  });
});
