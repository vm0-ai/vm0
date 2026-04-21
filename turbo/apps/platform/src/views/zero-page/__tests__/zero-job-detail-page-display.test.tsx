import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroUserConnectorsContract,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mockAPIs() {
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
      id: "e0000000-0000-4000-a000-000000000010",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: "preset:2",
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
        avatarUrl: "preset:2",
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

function mockAPIsWithConnectors() {
  mockAPIs();
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
  server.use(
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["slack"] });
    }),
    mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
      return respond(200, { enabledTypes: ["slack"] });
    }),
  );
}

describe("zero job detail page - display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render agent header elements (AGENT-D-016, AGENT-D-017)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "My Agent" })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("should show current agent name in breadcrumb (AGENT-D-019)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Agents");
    expect(breadcrumb).toHaveTextContent("My Agent");
  });

  it("should show schedule empty state when ?tab=schedule is active with no schedules (AGENT-D-020)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // When schedule tab is active with no schedules, the empty state image is rendered
    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "No schedules" }),
      ).toBeInTheDocument();
    });
  });

  it("should show not-found error state for unknown agent (AGENT-D-024)", async () => {
    setMockTeam([]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/agents/nonexistent" });

    // Not-found state shows a "Back to team" link instead of the agent heading
    await waitFor(() => {
      expect(screen.getByText("Back to team")).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "My Agent" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("zero job detail page - connector display", () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should show connector enabled and disabled states in permission list (AGENT-D-021)", async () => {
    mockAPIsWithConnectors();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    // Slack is enabled (in enabledTypes), Linear is disabled
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", { name: /Grant Linear access/i }),
    ).toBeInTheDocument();
  });

  it("should display filtered connector search results (AGENT-D-022)", async () => {
    mockAPIsWithConnectors();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Find connectors"));
    await user.type(screen.getByPlaceholderText("Find connectors..."), "sla");

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.queryByText("Linear")).not.toBeInTheDocument();
    });
  });

  it("should show connector name, status, and manage button in permission row (AGENT-D-025)", async () => {
    mockAPIsWithConnectors();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    // Status switch visible
    expect(
      screen.getByRole("switch", { name: /Slack access/i }),
    ).toBeInTheDocument();
    // Manage button visible (Slack has connector permissions)
    expect(
      screen.getByLabelText(/Manage Slack permissions/i),
    ).toBeInTheDocument();
  });
});

describe("zero job detail page - tab visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function findTab(label: RegExp) {
    return screen.getAllByRole("tab").find((el) => {
      return label.test(el.textContent ?? "");
    });
  }

  it("should show all tabs when user is the agent owner", async () => {
    mockAPIs();
    // Default mock user is "test-user-123" which matches ownerId
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    expect(findTab(/Profile/i)).toBeInTheDocument();
    expect(findTab(/Instructions/i)).toBeInTheDocument();
  });

  it("should show all tabs when user is org admin but not owner", async () => {
    mockAPIs();
    // Agent ownerId is "test-user-123", but user is "other-user"
    // Default org mock role is "admin"
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      user: { id: "other-user", fullName: "Other User" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    expect(findTab(/Profile/i)).toBeInTheDocument();
    expect(findTab(/Instructions/i)).toBeInTheDocument();
  });

  it("should hide Profile and Instructions tabs for non-owner non-admin", async () => {
    mockAPIs();
    // Override org to "member" role and user to non-owner
    setMockOrg({ role: "member" });
    detachedSetupPage({
      context,
      path: "/agents/my-agent",
      user: { id: "other-user", fullName: "Other User" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    expect(findTab(/Profile/i)).toBeUndefined();
    expect(findTab(/Instructions/i)).toBeUndefined();
    // Authorization and Scheduled should still be visible
    expect(findTab(/Authorization/i)).toBeInTheDocument();
    expect(findTab(/Scheduled/i)).toBeInTheDocument();
  });

  it("should coerce ?tab=profile to authorization for non-owner non-admin", async () => {
    mockAPIs();
    setMockOrg({ role: "member" });
    detachedSetupPage({
      context,
      path: "/agents/my-agent?tab=profile",
      user: { id: "other-user", fullName: "Other User" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Should show authorization tab content instead of profile
    expect(findTab(/Profile/i)).toBeUndefined();
    expect(findTab(/Authorization/i)).toBeInTheDocument();
  });
});

describe("zero job detail page - delete dialog", () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should open delete confirmation dialog (AGENT-D-026)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Switch to Profile tab
    await user.click(screen.getByText(/Profile/i));

    // Wait for settings form
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Delete agent/i));

    // Confirm the dialog is open via its accessible role
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
