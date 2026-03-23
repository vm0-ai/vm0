import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
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
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors,
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

async function renderTeamPage(connectors: string[]) {
  server.use(
    http.get("*/api/zero/agents/zero", () => {
      return HttpResponse.json({
        name: "zero",
        agentComposeId: "compose-1",
        description: null,
        displayName: null,
        sound: null,
        connectors,
      });
    }),
  );

  await setupPage({ context, path: "/team/zero" });
}

async function openAddConnectorDialog() {
  const addButton = await waitFor(() =>
    screen.getByRole("button", { name: /Add connector/i }),
  );
  fireEvent.click(addButton);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("zero add connection dialog", () => {
  it("opens dialog when Add connector is clicked", async () => {
    mockConnectors([]);
    await renderTeamPage([]);

    await openAddConnectorDialog();

    expect(screen.getByText(/Add connector to/)).toBeInTheDocument();
  });

  it("filters connectors by search text", async () => {
    mockConnectors([]);
    await renderTeamPage([]);

    await openAddConnectorDialog();

    // Wait for connector cards to load
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Type in search box to filter
    const searchInput = screen.getByPlaceholderText("Search...");
    fireEvent.change(searchInput, { target: { value: "github" } });

    // GitHub should still be visible
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Axiom should not be visible (filtered out)
    expect(screen.queryByText("Axiom")).not.toBeInTheDocument();
  });

  it("switches between Not connected and Connected tabs", async () => {
    // Slack is connected but NOT in addedSkills, so it appears in the dialog
    mockConnectors([
      makeConnector({
        type: "slack",
        authMethod: "oauth",
        oauthScopes: ["channels:read"],
      }),
    ]);
    await renderTeamPage([]);

    await openAddConnectorDialog();

    // Wait for connector list to load on the default "Not connected" tab
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Slack is connected, so it should NOT appear on the "Not connected" tab
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();

    // Click Connected tab
    fireEvent.click(screen.getByRole("tab", { name: /^Connected/ }));

    // Slack should appear on Connected tab
    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    // GitHub should not appear on Connected tab (not connected)
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("resets search when dialog is closed and reopened", async () => {
    mockConnectors([]);
    await renderTeamPage([]);

    await openAddConnectorDialog();

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Type search text
    const searchInput = screen.getByPlaceholderText("Search...");
    fireEvent.change(searchInput, { target: { value: "github" } });

    // Close dialog by pressing Escape
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Reopen dialog
    await openAddConnectorDialog();

    // Search should be cleared
    const newSearchInput = screen.getByPlaceholderText("Search...");
    expect(newSearchInput).toHaveValue("");
  });
});
