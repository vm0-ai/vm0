/**
 * Navigation, state, and conditional tests for ZeroSidebar component.
 *
 * Tests cover chat session list collapse/expand, agent list collapse/expand,
 * tab navigation, billing button, settings navigation, and scroll state.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { resetMockBilling } from "../../../mocks/handlers/api-billing.ts";
import { pathname } from "../../../signals/location.ts";
import { setIsScrolled$ } from "../../../signals/zero-page/zero-sidebar-state.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/core/contracts/chat-threads";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setChatAgentId$ } from "../../../signals/agent-chat.ts";

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
  agentId: string;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
  running: boolean;
} {
  return {
    id,
    title,
    agentId: DEFAULT_AGENT_ID,
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
}) {
  const agents = options?.agents ?? [makeDefaultAgent()];
  const threads = options?.threads ?? [];

  setMockTeam(agents);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
  );
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
  resetMockBilling();
});

describe("zero sidebar - chat session list collapses and expands (SIDEBAR-D-011)", () => {
  it("toggles chat thread list visibility when Chats header is clicked", async () => {
    mockBaseAPIs({
      threads: [
        makeThread("thread-1", "Deploy to prod", "2026-03-10T00:00:00Z"),
      ],
    });
    detachedSetupPage({ context, path: "/" });

    // Wait for thread to appear
    await waitFor(() => {
      expect(screen.getByText("Deploy to prod")).toBeInTheDocument();
    });

    // Collapse: click the "Chats with Zero" header span
    const chatsHeader = screen.getByText(/Chats with/);
    click(chatsHeader);

    // Thread list should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Deploy to prod")).not.toBeInTheDocument();
    });

    // Expand: click the header again
    click(chatsHeader);

    // Thread list should be visible again
    await waitFor(() => {
      expect(screen.getByText("Deploy to prod")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - agent list collapses and expands (SIDEBAR-D-012)", () => {
  it("toggles pinned agent visibility when Pinned header is clicked", async () => {
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    // Wait for pinned agent to appear
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    // Collapse: click the Pinned section header
    const pinnedHeader = screen.getByTestId("pinned-section-header");
    click(pinnedHeader);

    // Agent list should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });

    // Expand: click again
    click(pinnedHeader);

    // Agent list should be visible again
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - tab navigation switches active section (SIDEBAR-D-023)", () => {
  it("navigates to /agents when the Agents nav link is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const agentsLink = screen.getByText("Agents");
    click(agentsLink);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });

  it("navigates to /schedules when the Scheduled nav link is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const scheduledLink = screen.getByText("Scheduled");
    click(scheduledLink);

    await waitFor(() => {
      expect(pathname()).toBe("/schedules");
    });
  });
});

describe("zero sidebar - billing button opens billing dialog (SIDEBAR-D-024)", () => {
  it("opens the org manage dialog on billing tab when Get Pro button is clicked", async () => {
    mockBaseAPIs();
    // Default billing: tier = "free" → shows "Get Pro" card
    // Default org role from api-org handler: "admin" → upgrade card is shown

    detachedSetupPage({ context, path: "/" });

    // Wait for upgrade card to appear
    const upgradeBtn = await waitFor(() => {
      return screen.getByText("Get Pro");
    });

    click(upgradeBtn);

    // The org manage dialog should open
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - settings button navigates to settings (SIDEBAR-D-025)", () => {
  it("navigates to /settings when Preferences is clicked in account dropdown", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    // Open account dropdown
    click(screen.getByText("Test User"));

    // Click Preferences
    const preferencesItem = await waitFor(() => {
      return screen.getByText("Preferences");
    });
    click(preferencesItem);

    await waitFor(() => {
      expect(pathname()).toBe("/settings");
    });
  });
});

describe("zero sidebar - chat section stable during agent id reload (SIDEBAR-D-066)", () => {
  it("keeps chat thread list visible when currentChatAgentId$ briefly re-enters loading state", async () => {
    mockBaseAPIs({
      threads: [
        makeThread("thread-1", "Deploy to prod", "2026-03-10T00:00:00Z"),
      ],
    });
    detachedSetupPage({ context, path: "/" });

    // Wait for thread to appear in the sidebar
    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Deploy to prod")).toBeInTheDocument();
    });

    // Make the chat-threads API hang so any re-mount of ChatThreadsSection
    // (which triggers a fresh chatThreads$ fetch) would show skeleton while
    // waiting. Resolved after assertions for clean test teardown.
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.list, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { threads: [] });
      }),
    );

    // Simulate what setupChatPage does: update the internal agent id, which
    // briefly drives currentChatAgentId$ through a loading state. With
    // useLastResolved in ChatThreadsSectionWithKey the key stays stable and
    // ChatThreadsSection is never remounted, so the thread list must remain
    // visible without any skeleton appearing.
    context.store.set(setChatAgentId$, DEFAULT_AGENT_ID);

    // The thread text must remain visible and no skeleton should appear.
    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: "Sidebar" });
      expect(nav.querySelectorAll(".animate-pulse")).toHaveLength(0);
      expect(screen.getByText("Deploy to prod")).toBeInTheDocument();
    });

    // Resolve so the hanging handler finishes cleanly for afterEach.
    hangDeferred.resolve();
  });
});

describe("zero sidebar - sidebar scroll state persists (SIDEBAR-D-065)", () => {
  it("applies a box shadow to the scroll area when scrolled and removes it when back at top", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    const scrollArea = await waitFor(() => {
      return screen.getByTestId("sidebar-scroll-area");
    });

    // Initially not scrolled: no shadow
    expect(scrollArea.style.boxShadow).toBe("none");

    // Simulate scroll state update (as the onScroll handler would do)
    context.store.set(setIsScrolled$, true);

    // Shadow should appear when scrolled
    await waitFor(() => {
      expect(scrollArea.style.boxShadow).toBe(
        "0 -1px 0 0 hsl(var(--border) / 0.4)",
      );
    });

    // Simulate scrolling back to top
    context.store.set(setIsScrolled$, false);

    // Shadow should be removed
    await waitFor(() => {
      expect(scrollArea.style.boxShadow).toBe("none");
    });
  });
});
