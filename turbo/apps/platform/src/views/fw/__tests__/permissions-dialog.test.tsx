import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroAgentPermissionPoliciesContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs({
  connectorType = "slack" as ConnectorType,
  ownerId = "test-user-123",
  permissionPolicies = null as FirewallPolicies | null,
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
        ownerId,
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
      return respond(200, { enabledTypes: [connectorType] });
    }),
  );
  setMockConnectors([
    {
      id: "d0000001-0000-4000-a000-000000000001",
      type: connectorType,
      authMethod: "oauth",
      externalId: null,
      externalUsername: "testuser",
      externalEmail: null,
      oauthScopes: [],
      needsReconnect: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentPermissionPoliciesContract.update, ({ body, respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId,
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies: body.policies,
        customSkills: [],
      });
    }),
  );
}

async function openPermissionsDrawer(connectorLabel: string) {
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });

  await waitFor(() => {
    expect(
      screen.getByLabelText(`Manage ${connectorLabel} permissions`),
    ).toBeInTheDocument();
  });

  click(screen.getByLabelText(`Manage ${connectorLabel} permissions`));

  await waitFor(() => {
    expect(
      screen.getByRole("heading", {
        name: new RegExp(`${connectorLabel} permissions`, "i"),
      }),
    ).toBeInTheDocument();
  });
}

describe("permissions dialog - flat list connector (Notion)", () => {
  it("renders permission names and descriptions in flat list (FW-D-031)", async () => {
    mockAPIs({ connectorType: "notion" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Notion");

    await waitFor(() => {
      const permissionCodes = screen.getAllByRole("code");
      expect(permissionCodes.length).toBeGreaterThan(0);
    });
  });

  it("shows policy status for each permission (FW-D-033)", async () => {
    mockAPIs({
      connectorType: "notion",
      permissionPolicies: {
        notion: { policies: { insert_comments: "deny" } },
      },
    });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Notion");

    await waitFor(() => {
      const permissionCodes = screen.getAllByRole("code");
      expect(permissionCodes.length).toBeGreaterThan(0);
    });

    // insert_comments row should show Deny as pressed (active)
    const insertCommentsCode = screen.getAllByRole("code").find((el) => {
      return el.textContent === "insert_comments";
    });
    const insertCommentsRow = insertCommentsCode?.closest("div")
      ?.parentElement as HTMLElement;
    const denyBtn = within(insertCommentsRow)
      .getAllByRole("button")
      .find((b) => {
        return b.textContent?.includes("Deny") ?? false;
      });
    expect(denyBtn).toHaveAttribute("aria-pressed", "true");

    // read_content row should show Allow as pressed (default)
    const readContentCode = screen.getAllByRole("code").find((el) => {
      return el.textContent === "read_content";
    });
    const readContentRow = readContentCode?.closest("div")
      ?.parentElement as HTMLElement;
    const allowBtn = within(readContentRow)
      .getAllByRole("button")
      .find((b) => {
        return b.textContent?.includes("Allow") ?? false;
      });
    expect(allowBtn).toHaveAttribute("aria-pressed", "true");
  });
});

describe("permissions dialog - grouped connector (Slack)", () => {
  it("renders group categories with permission counts (FW-D-032)", async () => {
    mockAPIs({ connectorType: "slack" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    await waitFor(() => {
      expect(screen.getByText(/Read \(\d+\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Write \(\d+\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Admin \(\d+\)/i)).toBeInTheDocument();
    });
  });

  it("toggles group visibility on collapse/expand click (FW-D-035)", async () => {
    mockAPIs({ connectorType: "slack" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    const readButton = screen.getByText(/Read \(\d+\)/i);

    // Expand
    click(readButton);
    await waitFor(() => {
      return expect(screen.getByText("channels:read")).toBeInTheDocument();
    });

    // Collapse
    click(readButton);
    await waitFor(() => {
      return expect(
        screen.queryByText("channels:read"),
      ).not.toBeInTheDocument();
    });
  });

  it("saves policies and closes drawer when Apply is clicked (FW-D-036)", async () => {
    let putCalled = false;
    mockAPIs({ connectorType: "slack" });
    server.use(
      mockApi(zeroAgentPermissionPoliciesContract.update, ({ respond }) => {
        putCalled = true;
        return respond(200, {
          agentId: "e0000000-0000-4000-a000-000000000010",
          ownerId: "test-user-123",
          description: "A helpful agent",
          displayName: "My Agent",
          sound: null,
          avatarUrl: null,
          permissionPolicies: {},
          customSkills: [],
        });
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    click(screen.getByText("Apply"));

    await waitFor(() => {
      return expect(putCalled).toBeTruthy();
    });
    await waitFor(() => {
      return expect(
        screen.queryByRole("heading", { name: /Slack permissions/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("disables all policy pills and shows only Close in read-only mode (FW-V-001)", async () => {
    mockAPIs({ connectorType: "slack", ownerId: "other-user-456" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    // The footer "Close" button (text content) should be present
    await waitFor(() => {
      const closeButtons = screen.getAllByRole("button").filter((el) => {
        return el.textContent?.trim() === "Close";
      });
      // At least one of them is the footer close button (not the X icon)
      const footerClose = closeButtons.find((b) => {
        return b.textContent?.trim() === "Close";
      });
      expect(footerClose).toBeDefined();
    });
    expect(screen.queryByText("Apply")).not.toBeInTheDocument();

    // All policy pill buttons (Allow/Deny) should be disabled
    const allButtons = screen.getAllByRole("button");
    const policyButtons = allButtons.filter((b) => {
      return (
        (b.textContent?.includes("Allow") ?? false) ||
        (b.textContent?.includes("Deny") ?? false)
      );
    });
    expect(policyButtons.length).toBeGreaterThan(0);
    for (const btn of policyButtons) {
      expect(btn).toBeDisabled();
    }
  });
});
