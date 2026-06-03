import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockUserPermissionGrantResponse } from "../../../mocks/handlers/api-user-permission-grants.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs() {
  setMockConnectors([
    {
      id: "d0000001-0000-4000-a000-000000000001",
      type: "slack",
      authMethod: "oauth",
      externalId: null,
      externalUsername: "testuser",
      externalEmail: null,
      oauthScopes: ["channels:read", "chat:write"],
      needsReconnect: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "d0000002-0000-4000-a000-000000000002",
      type: "linear",
      authMethod: "oauth",
      externalId: null,
      externalUsername: "linearuser",
      externalEmail: null,
      oauthScopes: [],
      needsReconnect: false,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ]);
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
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["slack"] });
    }),
    mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
      return respond(200, { enabledTypes: ["slack"] });
    }),
  );
}

async function waitForPageLoad() {
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
}

describe("zero job detail page - interaction and state", () => {
  it("should switch tabs when tab trigger buttons are clicked (AGENT-D-027)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Switch to Scheduled tab
    const scheduledTab = queryAllByRoleFast("tab").find((el) => {
      return /Scheduled/i.test(el.textContent ?? "");
    });
    expect(scheduledTab).toBeDefined();
    click(scheduledTab!);
    await waitFor(() => {
      expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    });

    // Switch to Authorization tab
    click(screen.getByText(/Authorization/i));
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });
  });

  it("should switch tabs via mobile select dropdown (AGENT-D-028)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // The mobile Select has a combobox role
    const combobox = screen.getByRole("combobox");
    click(combobox);

    // Select "Profile" option
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Profile/i }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: /Profile/i }));

    // Profile tab content should show settings form
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });

  it("should navigate to chat when chat button is clicked (AGENT-D-029)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    click(screen.getByText("Chat with My Agent"));

    // Navigation should have updated the pathname to a chat path
    await waitFor(() => {
      expect(pathname()).toContain("/chat");
    });
  });

  it("should toggle connector access when switch is clicked (AGENT-D-030)", async () => {
    let putCalled = false;
    mockAPIs();
    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        putCalled = true;
        return respond(200, { enabledTypes: [] });
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });

    // Toggle Slack off (it's currently enabled)
    click(screen.getByRole("switch", { name: /Revoke Slack access/i }));

    await waitFor(() => {
      expect(putCalled).toBeTruthy();
    });
  });

  it("should open permissions drawer when manage button is clicked (AGENT-D-031)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Manage Slack permissions/i),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText(/Manage Slack permissions/i));

    // Drawer should open with Slack permissions heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Slack permissions/i }),
      ).toBeInTheDocument();
    });
  });

  it("should save current-user grants from permissions drawer", async () => {
    const grantBodies: unknown[] = [];

    mockAPIs();
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBodies.push(body);
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Manage Slack permissions/i),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText(/Manage Slack permissions/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Slack permissions/i }),
      ).toBeInTheDocument();
    });

    const readGroupButton = queryAllByRoleFast("button").find((element) => {
      return /^Read \(\d+\)$/.test(element.textContent ?? "");
    });
    expect(readGroupButton).toBeDefined();
    click(readGroupButton!);

    const permissionRow = screen
      .getByText("channels:read")
      .closest("div")?.parentElement;
    expect(permissionRow).not.toBeNull();
    const denyButton = queryAllByRoleFast(
      "button",
      permissionRow as HTMLElement,
    ).find((element) => {
      return element.textContent === "Deny";
    });
    expect(denyButton).toBeDefined();
    click(denyButton!);

    const applyButton = queryAllByRoleFast("button").find((element) => {
      return element.textContent === "Apply";
    });
    expect(applyButton).toBeDefined();
    click(applyButton!);

    await waitFor(() => {
      expect(grantBodies).toHaveLength(1);
    });
    expect(grantBodies[0]).toMatchObject({
      agentId: "e0000000-0000-4000-a000-000000000010",
      connectorRef: "slack",
      permission: "channels:read",
      action: "deny",
    });
  });

  it("should filter connector list when searching (AGENT-D-032)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for both connectors to be visible
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    // Click search button to activate search
    click(screen.getByLabelText("Find connectors"));

    // Type search query
    const searchInput = screen.getByPlaceholderText("Find connectors...");
    await user.type(searchInput, "sla");

    // Only Slack should be visible
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.queryByText("Linear")).not.toBeInTheDocument();
    });
  });

  it("should reset filter when search close button is clicked (AGENT-D-033)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    // Activate search and filter
    click(screen.getByLabelText("Find connectors"));
    const searchInput = screen.getByPlaceholderText("Find connectors...");
    await user.type(searchInput, "git");

    await waitFor(() => {
      expect(screen.queryByText("Linear")).not.toBeInTheDocument();
    });

    // Click close search button
    click(screen.getByLabelText("Close search"));

    // Both connectors should be visible again
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });
  });

  it("should open delete confirmation dialog (AGENT-D-034)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Switch to Profile tab
    click(screen.getByText(/Profile/i));

    // Wait for settings form to load
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    // Click delete agent button
    click(screen.getByText(/Delete agent/i));

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByText("Delete My Agent?")).toBeInTheDocument();
    });
  });

  it("should show loading state when toggling connector (AGENT-D-035)", async () => {
    const putDeferred = createDeferredPromise<void>(context.signal);

    mockAPIs();
    server.use(
      mockApi(zeroUserConnectorsContract.update, async ({ respond }) => {
        await putDeferred.promise;
        return respond(200, { enabledTypes: [] });
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });

    // Toggle Slack connector
    click(screen.getByRole("switch", { name: /Revoke Slack access/i }));

    // The switch should become disabled while the request is pending
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Slack access/i }),
      ).toBeDisabled();
    });

    // Resolve the pending request
    putDeferred.resolve();
  });

  it("should keep connector list visible during post-toggle refetch (AGENT-D-036)", async () => {
    // Regression test for #9141: toggling a connector triggers a refetch of
    // the user-connectors endpoint. The list must NOT flicker to the skeleton
    // during that refetch — the rows should stay visible the whole time.

    mockAPIs();

    // Hold the post-save GET so the refetch stays pending until we release it.
    const getDeferred = createDeferredPromise<void>(context.signal);
    let getCallCount = 0;
    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        return respond(200, { enabledTypes: [] });
      }),
      mockApi(zeroUserConnectorsContract.get, async ({ respond }) => {
        getCallCount += 1;
        // First call (initial seed) resolves immediately with slack enabled;
        // second call (the post-save refetch) blocks so we can observe the
        // in-between UI without slack enabled.
        if (getCallCount === 1) {
          return respond(200, { enabledTypes: ["slack"] });
        }
        await getDeferred.promise;
        return respond(200, { enabledTypes: [] });
      }),
    );
    detachedSetupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load initially.
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });

    // Toggle Slack off — this triggers PUT then a GET refetch (which is held).
    click(screen.getByRole("switch", { name: /Revoke Slack access/i }));

    // While the refetch is in-flight, the connector rows must remain rendered
    // (Slack and Linear are both visible — no skeleton swap).
    await waitFor(() => {
      expect(getCallCount).toBeGreaterThan(1);
    });
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();

    // Release the held GET so the test cleans up.
    getDeferred.resolve();
  });
});
