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
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  setSidebarExpanded$,
  sidebarOff$,
} from "../../../signals/zero-page/zero-nav.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockOrgMembers } from "../../../mocks/handlers/api-org-members.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mobileNativeOn(): Partial<Record<FeatureSwitchKey, boolean>> {
  return { [FeatureSwitchKey.MobileNativeV1]: true };
}

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
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    const menuButton = await waitFor(() => {
      return screen.getByLabelText("Open menu");
    });
    click(menuButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
  });
});

describe("sidebar layout - breadcrumb section link navigates (SIDEBAR-D-051)", () => {
  it("navigates to the section root when clicking the breadcrumb section link", async () => {
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
    click(agentsLink);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });
});

describe("sidebar layout - invite button opens member dialog (SIDEBAR-D-052)", () => {
  it("opens the org manage dialog on the members tab when Invite is clicked", async () => {
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
    click(inviteButton);

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

describe("sidebar layout - mod+b toggles desktop sidebar (SIDEBAR-D-055)", () => {
  it("toggles sidebarOff$ each time mod+b is pressed", async () => {
    const user = userEvent.setup();
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });

    expect(context.store.get(sidebarOff$)).toBeFalsy();

    await user.keyboard("{Control>}b{/Control}");
    expect(context.store.get(sidebarOff$)).toBeTruthy();

    await user.keyboard("{Control>}b{/Control}");
    expect(context.store.get(sidebarOff$)).toBeFalsy();
  });
});

describe("sidebar layout - overlay click collapses sidebar (SIDEBAR-D-054)", () => {
  it("hides the sidebar overlay when the overlay is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    // Expand the sidebar via signal to show the overlay
    context.store.set(setSidebarExpanded$, true);

    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });

    const overlay = screen.getByLabelText("Sidebar overlay");
    click(overlay);

    await waitFor(() => {
      expect(screen.queryByLabelText("Open menu")).toBeInTheDocument();
    });
  });
});

describe("mobile bottom tab bar - renders four tabs (MOBILE-TAB-001)", () => {
  it("renders Chats, Teammates, Schedules, and More tabs when MobileNativeV1 is on", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("mobile-bottom-tab-bar")).toBeInTheDocument();
    });

    expect(screen.getByTestId("mobile-tab-chats")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-teammates")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-schedules")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-more")).toBeInTheDocument();
  });
});

describe("mobile bottom tab bar - hidden when feature switch off (MOBILE-TAB-005)", () => {
  it("does not render when MobileNativeV1 is disabled", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    // Wait for layout to settle by asserting the existing top bar is present.
    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("mobile-bottom-tab-bar"),
    ).not.toBeInTheDocument();
  });
});

describe("mobile top bar - hamburger hidden when redesign on (MOBILE-TOP-001)", () => {
  it("does not render the Open menu hamburger when MobileNativeV1 is enabled", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: mobileNativeOn(),
    });

    // Bottom tab bar appears once the redesign is on — wait for that as a
    // settled-render signal rather than racing the hamburger query.
    await waitFor(() => {
      expect(screen.getByTestId("mobile-bottom-tab-bar")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Open menu")).not.toBeInTheDocument();
  });
});

describe("mobile top bar - org switcher pill shown when redesign on (MOBILE-TOP-002)", () => {
  it("renders the org switcher pill in place of the hamburger", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: mobileNativeOn(),
      org: {
        activeOrg: { id: "org_test", name: "vm0-ai" },
        memberships: [{ id: "org_test" }],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("mobile-org-switcher")).toBeInTheDocument();
    });
    expect(screen.getByTestId("mobile-org-switcher")).toHaveTextContent(
      "vm0-ai",
    );
  });
});

describe("mobile top bar - org switcher hidden when redesign off (MOBILE-TOP-003)", () => {
  it("does not render the org switcher pill with the default switch state", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("mobile-org-switcher")).not.toBeInTheDocument();
  });
});

describe("mobile bottom tab bar - active tab highlighted (MOBILE-TAB-002)", () => {
  it("marks the Teammates tab as the current page on /agents", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("mobile-tab-teammates")).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
    expect(screen.getByTestId("mobile-tab-chats")).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("mobile bottom tab bar - More opens sidebar (MOBILE-TAB-003)", () => {
  it("expands the sidebar overlay when the More tab is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: mobileNativeOn(),
    });

    const moreTab = await waitFor(() => {
      return screen.getByTestId("mobile-tab-more");
    });
    click(moreTab);

    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
  });
});

describe("mobile bottom tab bar - Schedules link navigates (MOBILE-TAB-004)", () => {
  it("navigates to /schedules when the Schedules tab is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: mobileNativeOn(),
    });

    const schedulesTab = await waitFor(() => {
      return screen.getByTestId("mobile-tab-schedules");
    });
    click(schedulesTab);

    await waitFor(() => {
      expect(pathname()).toBe("/schedules");
    });
  });
});
