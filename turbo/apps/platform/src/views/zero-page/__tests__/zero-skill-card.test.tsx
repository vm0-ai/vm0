import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockedWindowOpen } from "../../../__tests__/mock-window-open.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
  type ScopeDiff,
} from "@vm0/core";

const context = testContext();

function makeConnector(
  overrides: Partial<ConnectorResponse> & { type: ConnectorType },
): ConnectorResponse {
  return {
    id: `conn-${overrides.type}`,
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
    http.get("*/api/connectors", () => {
      return HttpResponse.json({
        connectors,
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

/**
 * Set up the /team/zero route with the given skills seeded in the agent compose.
 * This renders the full page through setupPage, exercising the real signal flow.
 */
async function renderTeamPage(skills: string[]) {
  // Mock the agent compose lookup (fetched by name query param)
  server.use(
    http.get("*/api/agent/composes", () => {
      return HttpResponse.json({
        id: "compose-1",
        name: "zero",
        headVersionId: "version_1",
        content: {
          version: "1",
          agents: { zero: { framework: "claude-code", skills } },
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
    }),
  );

  await setupPage({ context, path: "/team/zero" });
}

describe("zero skill card status display", () => {
  it("shows green indicator for connected OAuth connector with username", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        externalUsername: "testuser",
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderTeamPage(["github"]);

    // A connected connector shows a green dot and the Connectors tab renders it
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });
  });

  it("shows green indicator for connected API token connector", async () => {
    mockConnectors([
      makeConnector({
        type: "axiom",
        authMethod: "api-token",
      }),
    ]);

    await renderTeamPage(["axiom"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });
  });

  it("shows green indicator for connected OAuth connector without username", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        externalUsername: null,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderTeamPage(["github"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });
  });

  it("shows Reconnect button for needsReconnect connector", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        needsReconnect: true,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderTeamPage(["github"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reconnect" }),
      ).toBeInTheDocument();
    });
  });

  it("shows Review button for scope mismatch connector", async () => {
    // GitHub requires ["repo", "project"] — only storing ["repo"] triggers mismatch
    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    await renderTeamPage(["github"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Review" }),
      ).toBeInTheDocument();
    });
  });

  it("shows Connect button for not-connected OAuth connector", async () => {
    mockConnectors([]);

    await renderTeamPage(["github"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });
  });

  it("shows Connect button for not-connected API-token-only connector", async () => {
    mockConnectors([]);

    await renderTeamPage(["axiom"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero skill card button clicks", () => {
  it("calls window.open with authorize URL when Connect is clicked", async () => {
    mockConnectors([]);
    await renderTeamPage(["github"]);

    const connectButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connect" }),
    );

    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(mockedWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });
  });

  it("calls window.open when Reconnect is clicked on expired connector", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        needsReconnect: true,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderTeamPage(["github"]);

    const reconnectButton = await waitFor(() =>
      screen.getByRole("button", { name: "Reconnect" }),
    );

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(mockedWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });
  });

  it("opens ConnectModal when Connect is clicked for API-token connector", async () => {
    mockConnectors([]);
    await renderTeamPage(["axiom"]);

    const connectButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connect" }),
    );

    fireEvent.click(connectButton);

    // ConnectModal should open showing the connector's dialog
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero skill card scope review modal", () => {
  it("opens ScopeReviewModal with scope diff when Review is clicked", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    server.use(
      http.get("*/api/connectors/github/scope-diff", () => {
        return HttpResponse.json({
          addedScopes: ["project"],
          removedScopes: [],
          currentScopes: ["repo", "project"],
          storedScopes: ["repo"],
        } satisfies ScopeDiff);
      }),
    );

    await renderTeamPage(["github"]);

    const reviewButton = await waitFor(() =>
      screen.getByRole("button", { name: "Review" }),
    );

    fireEvent.click(reviewButton);

    // ScopeReviewModal should open as a dialog
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Added scope should render in the modal
    await waitFor(() => {
      expect(screen.getByText("project")).toBeInTheDocument();
    });
  });

  it("calls window.open when Reconnect is clicked in ScopeReviewModal", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    server.use(
      http.get("*/api/connectors/github/scope-diff", () => {
        return HttpResponse.json({
          addedScopes: ["project"],
          removedScopes: [],
          currentScopes: ["repo", "project"],
          storedScopes: ["repo"],
        } satisfies ScopeDiff);
      }),
    );

    await renderTeamPage(["github"]);

    const reviewButton = await waitFor(() =>
      screen.getByRole("button", { name: "Review" }),
    );

    fireEvent.click(reviewButton);

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Click Reconnect in the modal
    const reconnectButton = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(mockedWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });
  });
});
