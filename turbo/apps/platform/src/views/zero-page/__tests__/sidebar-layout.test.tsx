/**
 * Tests for SidebarLayout and MobileTopBar components.
 *
 * Covers breadcrumb rendering, admin-only invite button visibility,
 * menu toggle behavior, overlay click, and breadcrumb navigation.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { setSidebarExpanded$ } from "../../../signals/zero-page/zero-nav.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockOrgMembers } from "../../../mocks/handlers/api-org-members.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockBaseAPIs() {
  setMockTeam([
    {
      id: DEFAULT_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

describe("sidebar layout - breadcrumb section text (SIDEBAR-D-045)", () => {
  it("renders the breadcrumb section name in the mobile top bar", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/agents" });
    await waitFor(() => {
      // The breadcrumb renders a link in the mobile top bar pointing to /agents
      expect(
        screen.getAllByRole("link").some((el) => {
          return (
            el.getAttribute("href") === "/agents" &&
            el.textContent?.trim() === "Agents"
          );
        }),
      ).toBeTruthy();
    });
  });
});

describe("sidebar layout - breadcrumb name renders (SIDEBAR-D-046)", () => {
  it("renders the agent display name as breadcrumb item name", async () => {
    setMockTeam([
      {
        id: DEFAULT_AGENT_ID,
        displayName: "My Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    detachedSetupPage({ context, path: `/agents/${DEFAULT_AGENT_ID}` });

    await waitFor(() => {
      // The breadcrumb name renders as a truncated span with data-testid="breadcrumb-name"
      expect(screen.getByTestId("breadcrumb-name")).toHaveTextContent(
        "My Agent",
      );
    });
  });
});

describe("sidebar layout - breadcrumb avatar displays for agent pages (SIDEBAR-D-047)", () => {
  it("shows an agent avatar image in the breadcrumb for chat routes", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });
    await waitFor(() => {
      // AgentAvatarInTopBar renders an img with data-testid="agent-avatar" inside the mobile top bar
      expect(screen.getByTestId("agent-avatar")).toBeInTheDocument();
    });
  });
});

describe("sidebar layout - invite button shows for admins (SIDEBAR-D-048)", () => {
  it("renders the Invite button on chat routes for admin users", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });
    await waitFor(() => {
      expect(screen.getByText("Invite")).toBeInTheDocument();
    });
  });
});

describe("sidebar layout - invite button hidden for non-admins (SIDEBAR-D-049)", () => {
  it("does not render the Invite button for non-admin users", async () => {
    mockBaseAPIs();
    setMockOrg({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    detachedSetupPage({ context, path: "/" });
    await waitFor(() => {
      expect(screen.queryByText("Invite")).not.toBeInTheDocument();
    });
  });
});

describe("sidebar layout - menu toggle expands sidebar (SIDEBAR-D-050)", () => {
  it("expands the sidebar overlay when the menu toggle button is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    const menuButton = await waitFor(() => {
      return screen.getByLabelText("Open menu");
    });
    await user.click(menuButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
  });
});

describe("sidebar layout - breadcrumb section link navigates (SIDEBAR-D-051)", () => {
  it("navigates to the section root when clicking the breadcrumb section link", async () => {
    const user = userEvent.setup();
    setMockTeam([
      {
        id: DEFAULT_AGENT_ID,
        displayName: "My Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    detachedSetupPage({ context, path: `/agents/${DEFAULT_AGENT_ID}` });

    // Wait for the breadcrumb name to appear (initial route setup is complete)
    await waitFor(() => {
      expect(screen.getByTestId("breadcrumb-name")).toHaveTextContent(
        "My Agent",
      );
    });

    // Click the breadcrumb section link to /agents in the mobile top bar
    const agentsLink = screen.getAllByRole("link").find((el) => {
      return (
        el.getAttribute("href") === "/agents" &&
        el.textContent?.trim() === "Agents"
      );
    })!;
    await user.click(agentsLink);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });
});

describe("sidebar layout - invite button opens member dialog (SIDEBAR-D-052)", () => {
  it("opens the org manage dialog on the members tab when Invite is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    setMockOrgMembers({
      slug: "test-org",
      role: "admin",
      members: [],
      pendingInvitations: [],
      createdAt: "2024-01-01T00:00:00Z",
    });

    detachedSetupPage({ context, path: "/" });

    const inviteButton = await waitFor(() => {
      return screen.getByText("Invite");
    });
    await user.click(inviteButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Verify the Members tab is active (not General, Billing, etc.)
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Members" }),
      ).toBeInTheDocument();
    });
  });
});

describe("sidebar layout - overlay click collapses sidebar (SIDEBAR-D-054)", () => {
  it("hides the sidebar overlay when the overlay is clicked", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    // Expand the sidebar via signal to show the overlay
    context.store.set(setSidebarExpanded$, true);

    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });

    const overlay = screen.getByLabelText("Sidebar overlay");
    await user.click(overlay);

    await waitFor(() => {
      expect(screen.queryByLabelText("Open menu")).toBeInTheDocument();
    });
  });
});
