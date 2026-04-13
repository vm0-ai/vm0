import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
} from "@vm0/core";

const context = testContext();

function connectorUuid(type: string): string {
  const map: Record<string, string> = {
    github: "a0000000-0000-4000-a000-000000000001",
    slack: "a0000000-0000-4000-a000-000000000002",
    jira: "a0000000-0000-4000-a000-000000000003",
    linear: "a0000000-0000-4000-a000-000000000004",
    notion: "a0000000-0000-4000-a000-000000000005",
    google: "a0000000-0000-4000-a000-000000000006",
    asana: "a0000000-0000-4000-a000-000000000007",
    confluence: "a0000000-0000-4000-a000-000000000008",
    sentry: "a0000000-0000-4000-a000-000000000009",
    pagerduty: "a0000000-0000-4000-a000-000000000010",
  };
  return map[type] ?? "a0000000-0000-4000-a000-000000000099";
}

function makeConnector(
  overrides: Partial<ConnectorResponse> & { type: ConnectorType },
): ConnectorResponse {
  return {
    id: connectorUuid(overrides.type),
    authMethod: "oauth",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockConnectors(connectors: ConnectorResponse[]) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors,
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

/**
 * Set up the /team/zero route with the given user-connector permissions.
 * `orgConnectors` are the org-level connected connectors (shown in the list).
 * `enabledTypes` are the agent-level permissions (toggle checked state).
 */
function renderTeamPage(
  orgConnectors: ConnectorResponse[],
  enabledTypes: string[],
) {
  mockConnectors(orgConnectors);
  server.use(
    http.get("*/api/zero/agents/zero", () => {
      return HttpResponse.json({
        name: "zero",
        agentId: "compose-1",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/compose-1/user-connectors", () => {
      return HttpResponse.json({ enabledTypes });
    }),
  );

  detachedSetupPage({ context, path: "/agents/zero" });
}

describe("zero authorization tab — toggle rows", () => {
  it("shows a toggle row for a connected org connector", async () => {
    await renderTeamPage(
      [makeConnector({ type: "github", oauthScopes: ["repo", "project"] })],
      [],
    );

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
  });

  it("toggle is unchecked (Grant) when connector is not in enabledTypes", async () => {
    await renderTeamPage(
      [makeConnector({ type: "github", oauthScopes: ["repo", "project"] })],
      [],
    );

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Grant GitHub access" }),
      ).toBeInTheDocument();
    });
  });

  it("toggle is checked (Revoke) when connector is in enabledTypes", async () => {
    await renderTeamPage(
      [makeConnector({ type: "github", oauthScopes: ["repo", "project"] })],
      ["github"],
    );

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Revoke GitHub access" }),
      ).toBeInTheDocument();
    });
  });

  it("shows empty state when no org connectors are connected", async () => {
    await renderTeamPage([], []);

    await waitFor(() => {
      expect(screen.getByText(/No connected services yet/)).toBeInTheDocument();
    });
  });

  it("does not show unconnected org connectors in the authorization tab", async () => {
    // github is not connected at org level
    await renderTeamPage([], ["github"]);

    await waitFor(() => {
      expect(screen.getByText(/No connected services yet/)).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });
});

describe("zero authorization tab — multiple connectors", () => {
  it("shows all org-connected connectors as toggle rows", async () => {
    await renderTeamPage(
      [
        makeConnector({ type: "github", oauthScopes: ["repo", "project"] }),
        makeConnector({ type: "slack" }),
      ],
      ["github"],
    );

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    // GitHub is enabled, Slack is not
    expect(
      screen.getByRole("switch", { name: "Revoke GitHub access" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Grant Slack access" }),
    ).toBeInTheDocument();
  });
});

/**
 * Render the default agent's authorization tab as a non-admin member.
 * Connector permissions are user-level, so toggles remain interactive.
 */
function renderTeamPageAsMember(
  orgConnectors: ConnectorResponse[],
  enabledTypes: string[],
) {
  mockConnectors(orgConnectors);
  server.use(
    http.get("*/api/zero/agents/zero", () => {
      return HttpResponse.json({
        name: "zero",
        agentId: "compose-1",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/compose-1/user-connectors", () => {
      return HttpResponse.json({ enabledTypes });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "compose-1",
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "user-12345678",
        name: "User 12345678",
        role: "member",
      });
    }),
  );

  detachedSetupPage({ context, path: "/agents/zero" });
}

describe("zero authorization tab — member on default agent", () => {
  it("toggle is interactive (not disabled) because connector permissions are user-level", async () => {
    await renderTeamPageAsMember(
      [makeConnector({ type: "github", oauthScopes: ["repo", "project"] })],
      ["github"],
    );

    const toggleRow = await waitFor(() => {
      return screen.getByRole("switch", { name: "Revoke GitHub access" });
    });
    expect(toggleRow).not.toBeDisabled();
  });

  it("shows empty state when no org connectors", async () => {
    await renderTeamPageAsMember([], []);

    await waitFor(() => {
      expect(screen.getByText(/No connected services yet/)).toBeInTheDocument();
    });
  });

  it("shows toggle row for enabled connector", async () => {
    await renderTeamPageAsMember(
      [makeConnector({ type: "github", oauthScopes: ["repo", "project"] })],
      ["github"],
    );

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", { name: "Revoke GitHub access" }),
    ).toBeInTheDocument();
  });
});
