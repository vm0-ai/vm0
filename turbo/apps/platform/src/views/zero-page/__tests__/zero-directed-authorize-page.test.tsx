/**
 * Tests for the /connectors/:type/authorize page (ZeroDirectedAuthorizePage).
 *
 * Entry point: setupPage({ path: "/connectors/:type/authorize?agentId=..." })
 * Mock (external): connectors API, user-connectors API via MSW
 * Real (internal): signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { CONNECTOR_TYPES } from "@vm0/core";

const context = testContext();

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function mockConnectorsConnected(type: string) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: [
          {
            id: crypto.randomUUID(),
            type,
            authMethod: "oauth",
            externalId: null,
            externalUsername: null,
            externalEmail: null,
            oauthScopes: null,
            needsReconnect: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

describe("directed authorize page", () => {
  it("renders authorize card for a connected connector", async () => {
    mockConnectorsConnected("gmail");

    await setupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(CONNECTOR_TYPES.gmail.helpText),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize Zero" }),
    ).toBeInTheDocument();
  });

  it("shows authorized state after clicking authorize", async () => {
    const user = userEvent.setup();
    mockConnectorsConnected("gmail");

    await setupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Authorize Zero" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Authorize Zero" }));

    await waitFor(() => {
      expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
    });
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });

  it("renders nothing when agentId query param is missing", async () => {
    await setupPage({
      context,
      path: "/connectors/gmail/authorize",
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Authorize Zero" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing for an unknown connector type", async () => {
    await setupPage({
      context,
      path: `/connectors/nonexistent/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
  });

  it("normalizes uppercase type in URL", async () => {
    mockConnectorsConnected("gmail");

    await setupPage({
      context,
      path: `/connectors/Gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("has a logo link that navigates to /connectors", async () => {
    mockConnectorsConnected("gmail");

    await setupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    const logoLink = screen.getByLabelText("VM0");
    expect(logoLink.closest("a")).toHaveAttribute("href", "/connectors");
  });
});
