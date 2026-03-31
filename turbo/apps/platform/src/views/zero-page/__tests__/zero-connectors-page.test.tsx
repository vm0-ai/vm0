/**
 * Tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

const context = testContext();

function mockConnectors(
  connectors: {
    type: ConnectorType;
    externalUsername?: string;
    needsReconnect?: boolean;
    oauthScopes?: string[];
  }[],
) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: connectors.map((c) => ({
          id: crypto.randomUUID(),
          type: c.type,
          authMethod: "oauth",
          externalId: null,
          externalUsername: c.externalUsername ?? null,
          externalEmail: null,
          oauthScopes: c.oauthScopes ?? null,
          needsReconnect: c.needsReconnect ?? false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        })),
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

describe("connectors page", () => {
  it("renders the page header and search input", async () => {
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("Search connectors"),
    ).toBeInTheDocument();
  });

  it("shows available connectors when none are connected", async () => {
    await setupPage({ context, path: "/connectors" });

    // Default mock returns no connected connectors, so all should be in "Available"
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText(/Available/)).toBeInTheDocument();
    // "Connected" section should not appear
    expect(screen.queryByText(/Connected \(/)).not.toBeInTheDocument();
  });

  it("shows connected and available sections when some connectors are connected", async () => {
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText(/Connected \(/)).toBeInTheDocument();
    });
    // The connected connector should show the GitHub label
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText(/Available/)).toBeInTheDocument();
  });

  it("filters connectors by search term", async () => {
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors");
    fireEvent.change(searchInput, { target: { value: "github" } });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    // Slack should not be visible when searching for "github"
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("shows empty state when search has no matches", async () => {
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors");
    fireEvent.change(searchInput, {
      target: { value: "nonexistent-connector-xyz" },
    });

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });
});
