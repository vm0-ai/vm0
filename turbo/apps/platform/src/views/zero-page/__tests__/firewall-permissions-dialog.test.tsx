import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs({
  firewallPolicies = null,
}: { firewallPolicies?: Record<string, Record<string, string>> | null } = {}) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-detail-id",
          name: "my-agent",
          displayName: "My Agent",
          description: "A helpful agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        firewallPolicies,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: [
          {
            id: "d0000001-0000-4000-a000-000000000001",
            type: "slack",
            authMethod: "oauth",
            externalId: null,
            externalUsername: "testuser",
            externalEmail: null,
            oauthScopes: ["chat:write", "channels:read"],
            needsReconnect: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
        connectorProvidedSecretNames: [],
      });
    }),
    http.get("*/api/zero/agents/:id/user-connectors", () => {
      return HttpResponse.json({ enabledTypes: ["slack"] });
    }),
    http.put("*/api/zero/firewall-policies", async ({ request }) => {
      const body = (await request.json()) as {
        agentId: string;
        policies: Record<string, Record<string, string>>;
      };
      return HttpResponse.json({ firewallPolicies: body.policies });
    }),
  );
}

async function openPermissionsDrawer() {
  const user = userEvent.setup();

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });

  // Wait for connectors to load
  await waitFor(() => {
    expect(
      screen.getByLabelText(/Manage Slack permissions/i),
    ).toBeInTheDocument();
  });

  await user.click(screen.getByLabelText(/Manage Slack permissions/i));

  // Wait for drawer to open
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: /Slack permissions/i }),
    ).toBeInTheDocument();
  });

  return user;
}

describe("firewall permissions dialog - grouped connector (Slack)", () => {
  it("should show category groups collapsed by default with no global select-all", async () => {
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    // Category groups should be visible
    expect(screen.getByText(/Read \(\d+\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Write \(\d+\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Admin \(\d+\)/i)).toBeInTheDocument();

    // Global "Select all" should NOT be present (grouped connectors don't show it)
    expect(screen.queryByText(/Select all/i)).not.toBeInTheDocument();

    // Individual permissions should NOT be visible (collapsed by default)
    expect(screen.queryByText("bookmarks:read")).not.toBeInTheDocument();
    expect(screen.queryByText("bookmarks:write")).not.toBeInTheDocument();
  });

  it("should expand a group when its header is clicked and collapse when clicked again", async () => {
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    const user = await openPermissionsDrawer();

    const readButton = screen.getByText(/Read \(\d+\)/i);

    // Click to expand
    await user.click(readButton);

    // Individual read permissions should now be visible
    await waitFor(() => {
      expect(screen.getByText("bookmarks:read")).toBeInTheDocument();
    });

    // Click again to collapse
    await user.click(readButton);

    await waitFor(() => {
      expect(screen.queryByText("bookmarks:read")).not.toBeInTheDocument();
    });
  });

  it("should not highlight either Allow or Deny at group level when permissions are mixed", async () => {
    // Provide mixed policies: some allow, some deny within Read group
    mockAPIs({
      firewallPolicies: {
        slack: {
          "bookmarks:read": "allow",
          "channels:read": "deny",
        },
      },
    });
    await setupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    // Find the Read group row — it contains the group button and a PolicyPill
    const readButton = screen.getByText(/Read \(\d+\)/i);
    const readRow = readButton.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;
    expect(readRow).not.toBeNull();

    // Within that row, find the Allow/Deny buttons (the PolicyPill)
    const pillButtons = within(readRow).getAllByRole("button");
    // Filter to just Allow and Deny buttons (exclude the chevron toggle button)
    const allowBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });
    const denyBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Deny") ?? false;
    });

    expect(allowBtn).toBeDefined();
    expect(denyBtn).toBeDefined();

    // Neither should have the active "bg-muted" class (mixed state)
    expect(allowBtn!.className).not.toContain("bg-muted text-foreground");
    expect(denyBtn!.className).not.toContain("bg-muted text-foreground");
  });

  it("should highlight Allow at group level when all permissions in group are allow", async () => {
    // Default policies are all "allow" when not specified
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    const readButton = screen.getByText(/Read \(\d+\)/i);
    const readRow = readButton.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;

    const pillButtons = within(readRow).getAllByRole("button");
    const allowBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });

    // Should have active styling since all permissions default to "allow"
    expect(allowBtn!.className).toContain("bg-muted");
  });

  it("should set all permissions in a group when group-level Allow/Deny is clicked", async () => {
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    const user = await openPermissionsDrawer();

    // Click Deny on the Read group
    const readButton = screen.getByText(/Read \(\d+\)/i);
    const readRow = readButton.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;

    const pillButtons = within(readRow).getAllByRole("button");
    const denyBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Deny") ?? false;
    });
    await user.click(denyBtn!);

    // Expand the group to verify individual permissions
    await user.click(readButton);

    // All individual Read permissions should now show "Deny" as active
    await waitFor(() => {
      expect(screen.getByText("bookmarks:read")).toBeInTheDocument();
    });

    // Find an individual permission's Deny button and verify it's active
    const actionsReadRow = screen
      .getByText("bookmarks:read")
      .closest(".flex.items-center") as HTMLElement;
    const individualButtons = within(actionsReadRow).getAllByRole("button");
    const individualDeny = individualButtons.find((b) => {
      return b.textContent?.includes("Deny") ?? false;
    });
    expect(individualDeny!.className).toContain("bg-muted");
  });
});
