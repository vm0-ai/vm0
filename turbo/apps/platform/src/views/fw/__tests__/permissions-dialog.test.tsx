import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  createMockUserPermissionGrantResponse,
  setMockUserPermissionGrants,
} from "../../../mocks/handlers/api-user-permission-grants.ts";

const context = testContext();
const mockApi = createMockApi(context);
const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

function mockAPIs({
  connectorType = "slack" as ConnectorType,
  connectorTypes,
  ownerId = "test-user-123",
  userPermissionGrants = [],
}: {
  connectorType?: ConnectorType;
  connectorTypes?: readonly ConnectorType[];
  ownerId?: string;
  userPermissionGrants?: UserPermissionGrantResponse[];
} = {}) {
  setMockUserPermissionGrants(userPermissionGrants);
  const enabledTypes = [...(connectorTypes ?? [connectorType])];
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
        agentId: AGENT_ID,
        ownerId,
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes });
    }),
  );
  setMockConnectors(
    enabledTypes.map((type, index) => {
      return {
        id: `d0000001-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        type,
        authMethod: "oauth",
        externalId: null,
        externalUsername: "testuser",
        externalEmail: null,
        oauthScopes: [],
        connectionStatus: "connected",
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}

function mockGrant(
  connectorRef: ConnectorType,
  permission: string,
  action: UserPermissionGrantResponse["action"],
): UserPermissionGrantResponse {
  return createMockUserPermissionGrantResponse({
    agentId: AGENT_ID,
    connectorRef,
    permission,
    action,
  });
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

  const expectedHeading = `${connectorLabel} permissions`.toLowerCase();
  await waitFor(() => {
    expect(
      screen.getByRole("heading", {
        name: (accessibleName) => {
          return accessibleName.toLowerCase().includes(expectedHeading);
        },
      }),
    ).toBeInTheDocument();
  });
}

function getPermissionRow(permissionName: string): HTMLElement {
  const permissionCode = screen.getAllByRole("code").find((el) => {
    return el.textContent === permissionName;
  });
  const permissionRow = permissionCode?.closest("div")?.parentElement;
  if (!(permissionRow instanceof HTMLElement)) {
    throw new Error(`Permission row not found: ${permissionName}`);
  }
  return permissionRow;
}

function getPolicyButton(row: HTMLElement, label: string): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((el) => {
    return el.textContent?.includes(label) ?? false;
  });
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Policy button not found: ${label}`);
  }
  return button;
}

function getUnknownEndpointsRow(): HTMLElement {
  const label = screen.getByText("Other endpoints");
  const row = label.closest(".flex.items-center.justify-between");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Unknown endpoints row not found");
  }
  return row;
}

function getPermissionGroupHeader(category: string): HTMLElement {
  const label = screen.getByText((text) => {
    return text.startsWith(`${category} (`);
  });
  const row = label.closest("button")?.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Permission group header not found: ${category}`);
  }
  return row;
}

function getAllowOptionsButton(
  row: HTMLElement,
  permission: string,
): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((el) => {
    return el.getAttribute("aria-label") === `${permission} allow options`;
  });
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Allow options button not found: ${permission}`);
  }
  return button;
}

function getResetChangesButton(
  row: HTMLElement,
  permission: string,
): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((el) => {
    return el.getAttribute("aria-label") === `Reset ${permission} changes`;
  });
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Reset changes button not found: ${permission}`);
  }
  return button;
}

async function selectAllowDuration(
  row: HTMLElement,
  permission: string,
  option: string,
) {
  click(getAllowOptionsButton(row, permission));
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = queryAllByRoleFast("menuitem").find((el) => {
      return el.textContent?.includes(option) ?? false;
    });
    expect(item).toBeDefined();
  });
  click(item!);
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
      userPermissionGrants: [mockGrant("notion", "insert_comments", "deny")],
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
    const denyBtn = queryAllByRoleFast("button", insertCommentsRow).find(
      (b) => {
        return b.textContent?.includes("Deny") ?? false;
      },
    );
    expect(denyBtn).toHaveAttribute("aria-pressed", "true");

    // read_content row should show Allow as pressed (default)
    const readContentCode = screen.getAllByRole("code").find((el) => {
      return el.textContent === "read_content";
    });
    const readContentRow = readContentCode?.closest("div")
      ?.parentElement as HTMLElement;
    const allowBtn = queryAllByRoleFast("button", readContentRow).find((b) => {
      return b.textContent?.includes("Allow") ?? false;
    });
    expect(allowBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("allows updating expiration on an existing explicit grant", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({
      connectorType: "notion",
      userPermissionGrants: [
        createMockUserPermissionGrantResponse({
          agentId: AGENT_ID,
          connectorRef: "notion",
          permission: "insert_comments",
          action: "allow",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      ],
    });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    await waitFor(() => {
      expect(screen.getByText("< 1 hour")).toBeInTheDocument();
    });
    const row = getPermissionRow("insert_comments");
    const allowButton = getPolicyButton(row, "Allow");
    expect(allowButton).toHaveTextContent(/^Allow$/);
    expect(screen.getByText("Apply")).toBeDisabled();

    await selectAllowDuration(row, "insert_comments", "Allow for 7d");
    expect(allowButton).toHaveTextContent(/^Allow$/);
    expect(within(row).getByText("7d")).toBeInTheDocument();
    expect(screen.getByText("Apply")).toBeEnabled();

    click(screen.getByText("Apply"));

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "allow",
      expiresIn: "7d",
    });
  });

  it("treats default allow permissions as always and saves selected expiration", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({ connectorType: "notion" });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    const row = getPermissionRow("insert_comments");
    expect(within(row).getAllByText("Always").length).toBeGreaterThan(0);
    const allowButton = getPolicyButton(row, "Allow");
    expect(allowButton).toHaveTextContent(/^Allow$/);
    expect(screen.getByText("Apply")).toBeDisabled();

    await selectAllowDuration(row, "insert_comments", "Allow always");
    expect(allowButton).toHaveTextContent(/^Allow$/);
    expect(screen.getByText("Apply")).toBeDisabled();

    await selectAllowDuration(row, "insert_comments", "Allow for 24h");
    expect(allowButton).toHaveTextContent(/^Allow$/);
    expect(within(row).getByText("24h")).toBeInTheDocument();
    expect(screen.getByText("Apply")).toBeEnabled();
    click(screen.getByText("Apply"));

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "allow",
      expiresIn: "24h",
    });
  });

  it("does not keep deny expiration when an existing grant action changes", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({
      connectorType: "notion",
      userPermissionGrants: [
        createMockUserPermissionGrantResponse({
          agentId: AGENT_ID,
          connectorRef: "notion",
          permission: "insert_comments",
          action: "deny",
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        }),
      ],
    });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    const row = getPermissionRow("insert_comments");
    expect(screen.queryByText("2 hours")).not.toBeInTheDocument();
    expect(within(row).queryByText("Always")).not.toBeInTheDocument();
    click(getPolicyButton(row, "Allow"));
    expect(getPolicyButton(row, "Allow")).toHaveTextContent(/^Allow$/);
    expect(within(row).getByText("Always")).toBeInTheDocument();
    click(screen.getByText("Apply"));

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "allow",
    });
    expect(grantBodies[0]).not.toMatchObject({
      expiresIn: expect.any(String),
    });
  });

  it("saves selected expiration for a newly changed grant", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({
      connectorType: "notion",
      userPermissionGrants: [mockGrant("notion", "insert_comments", "deny")],
    });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    const row = getPermissionRow("insert_comments");
    await selectAllowDuration(row, "insert_comments", "Allow for 24h");
    click(screen.getByText("Apply"));

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "allow",
      expiresIn: "24h",
    });
  });

  it("resets pending allow duration changes from allow options", async () => {
    mockAPIs({
      connectorType: "notion",
      userPermissionGrants: [mockGrant("notion", "insert_comments", "deny")],
    });
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    const row = getPermissionRow("insert_comments");
    click(getAllowOptionsButton(row, "insert_comments"));

    let menuItems: HTMLElement[] = [];
    await waitFor(() => {
      menuItems = queryAllByRoleFast("menuitem");
      expect(menuItems.length).toBeGreaterThan(0);
    });
    expect(
      menuItems.some((item) => {
        return item.textContent?.trim() === "Allow";
      }),
    ).toBeFalsy();
    expect(
      menuItems.some((item) => {
        return item.textContent?.includes("Keep current") ?? false;
      }),
    ).toBeFalsy();

    const allowFor24h = menuItems.find((item) => {
      return item.textContent?.includes("Allow for 24h") ?? false;
    });
    if (!(allowFor24h instanceof HTMLElement)) {
      throw new Error("Allow for 24h menu item not found");
    }
    click(allowFor24h);

    expect(getPolicyButton(row, "Allow")).toHaveTextContent(/^Allow$/);
    expect(within(row).getByText("24h")).toBeInTheDocument();
    expect(screen.getByText("Apply")).toBeEnabled();

    click(getResetChangesButton(row, "insert_comments"));

    expect(getPolicyButton(row, "Deny")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(getPolicyButton(row, "Allow")).toHaveTextContent(/^Allow$/);
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("does not show expiration controls for deny changes", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({ connectorType: "notion" });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Notion");

    const row = getPermissionRow("insert_comments");
    const denyButton = getPolicyButton(row, "Deny");
    click(denyButton);
    expect(denyButton).toHaveAttribute("aria-pressed", "true");
    expect(within(row).queryByText("Always")).not.toBeInTheDocument();
    click(screen.getByText("Apply"));

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "deny",
    });
    expect(grantBodies[0]).not.toMatchObject({
      expiresIn: expect.any(String),
    });
  });
});

describe("permissions dialog - grouped connector (Slack)", () => {
  it("reinitializes grant policies and only writes changed connector grants", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({
      connectorTypes: ["slack", "notion"],
      userPermissionGrants: [
        mockGrant("slack", "channels:read", "deny"),
        mockGrant("slack", UNKNOWN_PERMISSION_GRANT, "deny"),
        mockGrant("notion", "insert_comments", "deny"),
        mockGrant("notion", UNKNOWN_PERMISSION_GRANT, "deny"),
      ],
    });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await openPermissionsDrawer("Slack");
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      return expect(
        screen.queryByRole("heading", { name: /Slack permissions/i }),
      ).not.toBeInTheDocument();
    });

    await openPermissionsDrawer("Notion");
    await waitFor(() => {
      const denyButton = getPolicyButton(
        getPermissionRow("insert_comments"),
        "Deny",
      );
      expect(denyButton).toHaveAttribute("aria-pressed", "true");
    });
    click(getPolicyButton(getPermissionRow("insert_comments"), "Allow"));

    click(screen.getByText("Apply"));

    await waitFor(() => {
      return expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "notion",
      permission: "insert_comments",
      action: "allow",
    });
  });

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

  it("sets and resets expiration from grouped permission controls", async () => {
    mockAPIs({ connectorType: "slack" });
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Slack");

    const readGroup = getPermissionGroupHeader("Read");
    await selectAllowDuration(readGroup, "Read", "Allow for 24h");
    expect(screen.getByText("Apply")).toBeEnabled();

    click(screen.getByText(/Read \(\d+\)/i));
    await waitFor(() => {
      expect(screen.getByText("channels:read")).toBeInTheDocument();
    });
    const channelsReadRow = getPermissionRow("channels:read");
    expect(getPolicyButton(channelsReadRow, "Allow")).toHaveTextContent(
      /^Allow$/,
    );
    expect(within(channelsReadRow).getByText("24h")).toBeInTheDocument();

    click(getResetChangesButton(readGroup, "Read"));
    expect(getPolicyButton(channelsReadRow, "Allow")).toHaveTextContent(
      "Allow",
    );
    expect(screen.getByText("Apply")).toBeDisabled();
  });

  it("shows always when a grouped deny change returns to allow", async () => {
    mockAPIs({ connectorType: "slack" });
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });
    await openPermissionsDrawer("Slack");

    const readGroup = getPermissionGroupHeader("Read");
    click(getPolicyButton(readGroup, "Deny"));
    expect(within(readGroup).queryByText("Always")).not.toBeInTheDocument();

    click(getPolicyButton(readGroup, "Allow"));
    expect(within(readGroup).getByText("Always")).toBeInTheDocument();

    click(screen.getByText(/Read \(\d+\)/i));
    await waitFor(() => {
      expect(screen.getByText("channels:read")).toBeInTheDocument();
    });
    expect(
      within(getPermissionRow("channels:read")).getByText("Always"),
    ).toBeInTheDocument();
  });

  it("saves changed grants and closes drawer when Apply is clicked (FW-D-036)", async () => {
    const grantBodies: unknown[] = [];
    mockAPIs({ connectorType: "slack" });
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    click(screen.getByText(/Read \(\d+\)/i));
    click(getPolicyButton(getPermissionRow("channels:read"), "Deny"));
    click(screen.getByText("Apply"));

    await waitFor(() => {
      return expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "slack",
      permission: "channels:read",
      action: "deny",
    });
    await waitFor(() => {
      return expect(
        screen.queryByRole("heading", { name: /Slack permissions/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("enables Apply only when permission policies changed", async () => {
    mockAPIs({ connectorType: "slack" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    const applyButton = screen.getByText("Apply");
    expect(applyButton).toBeDisabled();

    click(screen.getByText(/Read \(\d+\)/i));
    const channelsReadRow = getPermissionRow("channels:read");
    click(getPolicyButton(channelsReadRow, "Deny"));
    expect(applyButton).toBeEnabled();

    click(getPolicyButton(channelsReadRow, "Allow"));
    expect(applyButton).toBeDisabled();

    click(getPolicyButton(getUnknownEndpointsRow(), "Deny"));
    expect(applyButton).toBeEnabled();
  });

  it("allows org admins to manage permissions for agents owned by another user (FW-V-001)", async () => {
    mockAPIs({ connectorType: "slack", ownerId: "other-user-456" });
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await openPermissionsDrawer("Slack");

    await waitFor(() => {
      expect(screen.getByText("Apply")).toBeInTheDocument();
    });

    const allButtons = queryAllByRoleFast("button");
    const policyButtons = allButtons.filter((b) => {
      return (
        (b.textContent?.includes("Allow") ?? false) ||
        (b.textContent?.includes("Deny") ?? false)
      );
    });
    expect(policyButtons.length).toBeGreaterThan(0);
    for (const btn of policyButtons) {
      expect(btn).toBeEnabled();
    }
  });
});
