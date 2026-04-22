import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockPinnedAgents() {
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
    {
      id: "agent-alpha",
      displayName: "Alpha Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-beta",
      displayName: "Beta Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_3",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  setMockUserPreferences({ pinnedAgentIds: ["agent-alpha", "agent-beta"] });
}

/** Find the pinned agent link inside the sidebar nav (not the main page area). */
function getPinnedLink(name: string): HTMLAnchorElement {
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  const link = within(sidebar).getByText(name).closest("a");
  if (!link) {
    throw new Error(`Pinned link for "${name}" not found in sidebar`);
  }
  return link;
}

describe("pinned agent switch (#6897)", () => {
  it("should highlight the switched-to pinned agent after clicking it", async () => {
    mockPinnedAgents();

    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });

    // Wait for pinned agents to render in the sidebar
    await waitFor(() => {
      expect(
        within(screen.getByRole("navigation", { name: "Sidebar" })).getByText(
          "Alpha Bot",
        ),
      ).toBeInTheDocument();
    });

    // Alpha Bot should be highlighted in the sidebar
    expect(getPinnedLink("Alpha Bot").className).toContain("bg-gray-200");

    // Click Beta Bot pinned agent in sidebar
    click(getPinnedLink("Beta Bot"));

    // URL should update to beta agent
    await waitFor(() => {
      expect(pathname()).toBe("/agents/agent-beta/chat");
    });

    // Beta Bot should now be highlighted, Alpha Bot should not
    await waitFor(() => {
      expect(getPinnedLink("Beta Bot").className).toContain("bg-gray-200");
    });
    expect(getPinnedLink("Alpha Bot").className).not.toContain("bg-gray-200");
  });

  it("should highlight the switched-to pinned agent when switching back", async () => {
    mockPinnedAgents();

    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });

    await waitFor(() => {
      expect(
        within(screen.getByRole("navigation", { name: "Sidebar" })).getByText(
          "Alpha Bot",
        ),
      ).toBeInTheDocument();
    });

    // Switch to Beta
    click(getPinnedLink("Beta Bot"));
    await waitFor(() => {
      expect(getPinnedLink("Beta Bot").className).toContain("bg-gray-200");
    });

    // Switch back to Alpha
    click(getPinnedLink("Alpha Bot"));
    await waitFor(() => {
      expect(getPinnedLink("Alpha Bot").className).toContain("bg-gray-200");
    });
    expect(getPinnedLink("Beta Bot").className).not.toContain("bg-gray-200");
  });
});
