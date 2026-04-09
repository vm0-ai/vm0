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
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { resetMockBilling } from "../../../mocks/handlers/api-billing.ts";
import { pathname } from "../../../signals/location.ts";
import { setIsScrolled$ } from "../../../signals/zero-page/zero-sidebar-state.ts";

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
  );
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
  resetMockBilling();
});

describe("zero sidebar - chat session list collapses and expands (SIDEBAR-D-011)", () => {
  it("toggles chat thread list visibility when Chats header is clicked", async () => {
    const user = userEvent.setup();
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
    await user.click(chatsHeader);

    // Thread list should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Deploy to prod")).not.toBeInTheDocument();
    });

    // Expand: click the header again
    await user.click(chatsHeader);

    // Thread list should be visible again
    await waitFor(() => {
      expect(screen.getByText("Deploy to prod")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - agent list collapses and expands (SIDEBAR-D-012)", () => {
  it("toggles pinned agent visibility when Pinned header is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    // Wait for pinned agent to appear
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    // Collapse: click the Pinned section header
    const pinnedHeader = screen.getByTestId("pinned-section-header");
    await user.click(pinnedHeader);

    // Agent list should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });

    // Expand: click again
    await user.click(pinnedHeader);

    // Agent list should be visible again
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - tab navigation switches active section (SIDEBAR-D-023)", () => {
  it("navigates to /agents when the Agents nav link is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const agentsLink = screen.getByText("Agents");
    await user.click(agentsLink);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });

  it("navigates to /schedules when the Scheduled nav link is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const scheduledLink = screen.getByText("Scheduled");
    await user.click(scheduledLink);

    await waitFor(() => {
      expect(pathname()).toBe("/schedules");
    });
  });
});

describe("zero sidebar - billing button opens billing dialog (SIDEBAR-D-024)", () => {
  it("opens the org manage dialog on billing tab when Get Pro button is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    // Default billing: tier = "free" → shows "Get Pro" card
    // Default org role from api-org handler: "admin" → upgrade card is shown

    detachedSetupPage({ context, path: "/" });

    // Wait for upgrade card to appear
    const upgradeBtn = await waitFor(() => {
      return screen.getByText("Get Pro");
    });

    await user.click(upgradeBtn);

    // The org manage dialog should open
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - settings button navigates to settings (SIDEBAR-D-025)", () => {
  it("navigates to /settings when Preferences is clicked in account dropdown", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    // Open account dropdown
    await user.click(screen.getByText("Test User"));

    // Click Preferences
    const preferencesItem = await waitFor(() => {
      return screen.getByText("Preferences");
    });
    await user.click(preferencesItem);

    await waitFor(() => {
      expect(pathname()).toBe("/settings");
    });
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
