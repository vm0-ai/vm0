import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { FirewallPolicies } from "@vm0/core/contracts/firewalls";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroAgentPermissionPoliciesContract,
} from "@vm0/core/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/core/contracts/user-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs({
  permissionPolicies = null,
}: {
  permissionPolicies?: FirewallPolicies | null;
} = {}) {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["slack"] });
    }),
  );
  setMockConnectors([
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
  ]);
  server.use(
    mockApi(zeroAgentPermissionPoliciesContract.update, ({ body, respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: body.policies,
        customSkills: [],
      });
    }),
  );
}

async function openPermissionsDrawer() {
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

  click(screen.getByLabelText(/Manage Slack permissions/i));

  // Wait for drawer to open
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: /Slack permissions/i }),
    ).toBeInTheDocument();
  });
}

describe("permissions dialog - grouped connector (Slack)", () => {
  it("should show category groups collapsed by default with no global select-all", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
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
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    const readButton = screen.getByText(/Read \(\d+\)/i);

    // Click to expand
    click(readButton);

    // Individual read permissions should now be visible
    await waitFor(() => {
      expect(screen.getByText("bookmarks:read")).toBeInTheDocument();
    });

    // Click again to collapse
    click(readButton);

    await waitFor(() => {
      expect(screen.queryByText("bookmarks:read")).not.toBeInTheDocument();
    });
  });

  it("should not highlight either Allow or Deny at group level when permissions are mixed", async () => {
    // Provide mixed policies: some allow, some deny within Read group
    mockAPIs({
      permissionPolicies: {
        slack: {
          policies: {
            "bookmarks:read": "allow",
            "channels:read": "deny",
          },
        },
      },
    });
    detachedSetupPage({ context, path: "/agents/my-agent" });
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

    // Neither should have an active semantic color class (mixed state)
    expect(allowBtn!.className).not.toContain("bg-emerald");
    expect(denyBtn!.className).not.toContain("bg-rose");
  });

  it("should highlight Allow at group level when all permissions in group are allow", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    const readButton = screen.getByText(/Read \(\d+\)/i);
    const readRow = readButton.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;

    const pillButtons = within(readRow).getAllByRole("button");
    const allowBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });

    // Click Allow to ensure the group is explicitly set to "allow"
    click(allowBtn!);

    await waitFor(() => {
      expect(allowBtn!.className).toContain("bg-emerald");
    });
  });

  it("should set all permissions in a group when group-level Allow/Deny is clicked", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    // Click Deny on the Read group
    const readButton = screen.getByText(/Read \(\d+\)/i);
    const readRow = readButton.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;

    const pillButtons = within(readRow).getAllByRole("button");
    const denyBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Deny") ?? false;
    });
    click(denyBtn!);

    // Expand the group to verify individual permissions
    click(readButton);

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
    expect(individualDeny!.className).toContain("bg-rose");
  });

  it("should show unknown endpoints toggle defaulting to Allow", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    expect(screen.getByText("Other endpoints")).toBeInTheDocument();

    // Find the unknown endpoints row
    const unknownLabel = screen.getByText("Other endpoints");
    const unknownRow = unknownLabel.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;
    expect(unknownRow).not.toBeNull();

    const pillButtons = within(unknownRow).getAllByRole("button");
    const allowBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });
    expect(allowBtn!.className).toContain("bg-emerald");
  });

  it("should show unknown endpoints as Allow when saved as allow", async () => {
    mockAPIs({});
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer();

    const unknownLabel = screen.getByText("Other endpoints");
    const unknownRow = unknownLabel.closest(
      ".flex.items-center.justify-between",
    ) as HTMLElement;

    const pillButtons = within(unknownRow).getAllByRole("button");
    const allowBtn = pillButtons.find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });
    expect(allowBtn!.className).toContain("bg-emerald");
  });
});
