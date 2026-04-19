import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import {
  type ConnectorType,
  zeroAgentPermissionPoliciesContract,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

function mockAPIs({
  connectorType = "slack" as ConnectorType,
  ownerId = "test-user-123",
  permissionPolicies = null as Record<
    string,
    { policies: Record<string, string>; unknownPolicy?: string }
  > | null,
} = {}) {
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
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId,
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        permissionPolicies,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
    http.get("*/api/zero/agents/:id/user-connectors", () => {
      return HttpResponse.json({ enabledTypes: [connectorType] });
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
  const user = userEvent.setup();

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

  await user.click(
    screen.getByLabelText(`Manage ${connectorLabel} permissions`),
  );

  await waitFor(() => {
    expect(
      screen.getByRole("heading", {
        name: new RegExp(`${connectorLabel} permissions`, "i"),
      }),
    ).toBeInTheDocument();
  });

  return user;
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
    const user = await openPermissionsDrawer("Slack");

    const readButton = screen.getByText(/Read \(\d+\)/i);

    // Expand
    await user.click(readButton);
    await waitFor(() => {
      return expect(screen.getByText("channels:read")).toBeInTheDocument();
    });

    // Collapse
    await user.click(readButton);
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
    const user = await openPermissionsDrawer("Slack");

    await user.click(screen.getByText("Apply"));

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
