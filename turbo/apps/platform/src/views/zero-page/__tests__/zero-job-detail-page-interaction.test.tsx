import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockAPIs() {
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
        permissionPolicies: null,
        allowUnknownEndpoints: null,
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
        ],
        configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
        connectorProvidedSecretNames: [],
      });
    }),
    http.get("*/api/zero/agents/:id/user-connectors", () => {
      return HttpResponse.json({ enabledTypes: ["slack"] });
    }),
    http.put("*/api/zero/agents/:id/user-connectors", () => {
      return HttpResponse.json({ enabledTypes: ["slack"] });
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
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Switch to Scheduled tab
    const scheduledTab = screen.getAllByRole("tab").find((el) => {
      return /Scheduled/i.test(el.textContent ?? "");
    });
    expect(scheduledTab).toBeDefined();
    await user.click(scheduledTab!);
    await waitFor(() => {
      expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    });

    // Switch to Authorization tab
    await user.click(screen.getByText(/Authorization/i));
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });
  });

  it("should switch tabs via mobile select dropdown (AGENT-D-028)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // The mobile Select has a combobox role
    const combobox = screen.getByRole("combobox");
    await user.click(combobox);

    // Select "Profile" option
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Profile/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: /Profile/i }));

    // Profile tab content should show settings form
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });

  it("should navigate to chat when chat button is clicked (AGENT-D-029)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    await user.click(screen.getByText("Chat with My Agent"));

    // Navigation should have updated the pathname to a chat path
    await waitFor(() => {
      expect(pathname()).toContain("/chat");
    });
  });

  it("should toggle connector access when switch is clicked (AGENT-D-030)", async () => {
    const user = userEvent.setup();
    let putCalled = false;
    mockAPIs();
    server.use(
      http.put("*/api/zero/agents/:id/user-connectors", () => {
        putCalled = true;
        return HttpResponse.json({ enabledTypes: [] });
      }),
    );
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });

    // Toggle Slack off (it's currently enabled)
    await user.click(
      screen.getByRole("switch", { name: /Revoke Slack access/i }),
    );

    await waitFor(() => {
      expect(putCalled).toBeTruthy();
    });
  });

  it("should open permissions drawer when manage button is clicked (AGENT-D-031)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Manage Slack permissions/i),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText(/Manage Slack permissions/i));

    // Drawer should open with Slack permissions heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Slack permissions/i }),
      ).toBeInTheDocument();
    });
  });

  it("should filter connector list when searching (AGENT-D-032)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for both connectors to be visible
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    // Click search button to activate search
    await user.click(screen.getByLabelText("Search connectors"));

    // Type search query
    const searchInput = screen.getByPlaceholderText("Search connectors...");
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
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    // Activate search and filter
    await user.click(screen.getByLabelText("Search connectors"));
    const searchInput = screen.getByPlaceholderText("Search connectors...");
    await user.type(searchInput, "git");

    await waitFor(() => {
      expect(screen.queryByText("Linear")).not.toBeInTheDocument();
    });

    // Click close search button
    await user.click(screen.getByLabelText("Close search"));

    // Both connectors should be visible again
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });
  });

  it("should open delete confirmation dialog (AGENT-D-034)", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Switch to Profile tab
    await user.click(screen.getByText(/Profile/i));

    // Wait for settings form to load
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    // Click delete agent button
    await user.click(screen.getByText(/Delete agent/i));

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByText("Delete My Agent?")).toBeInTheDocument();
    });
  });

  it("should show loading state when toggling connector (AGENT-D-035)", async () => {
    const user = userEvent.setup();
    let resolvePut: (() => void) | undefined;
    const putPromise = new Promise<void>((resolve) => {
      resolvePut = resolve;
    });

    mockAPIs();
    server.use(
      http.put("*/api/zero/agents/:id/user-connectors", async () => {
        await putPromise;
        return HttpResponse.json({ enabledTypes: [] });
      }),
    );
    await setupPage({ context, path: "/agents/my-agent" });
    await waitForPageLoad();

    // Wait for connectors to load
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Revoke Slack access/i }),
      ).toBeInTheDocument();
    });

    // Toggle Slack connector
    await user.click(
      screen.getByRole("switch", { name: /Revoke Slack access/i }),
    );

    // The switch should become disabled while the request is pending
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Slack access/i }),
      ).toBeDisabled();
    });

    // Resolve the pending request
    resolvePut?.();
  });
});
