/**
 * Tests for the /connectors/:type/authorize page (ZeroDirectedAuthorizePage).
 *
 * Entry point: setupPage({ path: "/connectors/:type/authorize?agentId=..." })
 * Mock (external): connectors API, user-connectors API via MSW
 * Real (internal): signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function mockAgentWithName(agentId: string, displayName: string) {
  setMockTeam([
    {
      id: agentId,
      displayName,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function mockConnectorsConnected(type: ConnectorType) {
  setMockConnectors([
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
  ]);
}

describe("directed authorize page", () => {
  it("renders authorize card for a connected connector", async () => {
    mockConnectorsConnected("gmail");

    detachedSetupPage({
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
    expect(screen.getByText("Authorize Zero")).toBeInTheDocument();
  });

  it("shows authorized state after clicking authorize", async () => {
    mockConnectorsConnected("gmail");

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Authorize Zero")).toBeInTheDocument();
    });

    click(screen.getByText("Authorize Zero"));

    await waitFor(() => {
      expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
    });
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });

  it("renders nothing when agentId query param is missing", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/gmail/authorize",
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Authorize Zero")).not.toBeInTheDocument();
  });

  it("renders nothing for an unknown connector type", async () => {
    detachedSetupPage({
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

    detachedSetupPage({
      context,
      path: `/connectors/Gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("shows authorized state when connector is already authorized for agent", async () => {
    mockConnectorsConnected("gmail");
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["gmail"] });
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
    });
    expect(screen.getByText("Authorized")).toBeInTheDocument();
    expect(screen.queryByText("Authorize Zero")).not.toBeInTheDocument();
  });

  it("shows authorize button when connector is not yet authorized for agent", async () => {
    mockConnectorsConnected("gmail");
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Authorize Zero")).toBeInTheDocument();
  });

  it("shows agent display name instead of 'Zero' when agent has a name", async () => {
    mockAgentWithName(AGENT_ID, "My Assistant");
    mockConnectorsConnected("gmail");

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("My Assistant needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Authorize My Assistant")).toBeInTheDocument();
  });

  it("has a logo link that navigates to /connectors", async () => {
    mockConnectorsConnected("gmail");

    detachedSetupPage({
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

  it("shows Google OAuth notice when Google connector is not yet connected (AUTH-D-060)", async () => {
    // No mockConnectorsConnected → connector not in the connected list
    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
  });

  it("does not show Google OAuth notice when Google connector is already connected (AUTH-D-061)", async () => {
    mockConnectorsConnected("gmail");

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not show Google OAuth notice when connector is already authorized (AUTH-D-062)", async () => {
    mockConnectorsConnected("gmail");
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["gmail"] });
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not show Google OAuth notice for non-Google OAuth connectors (AUTH-D-063)", async () => {
    mockConnectorsConnected("github");

    detachedSetupPage({
      context,
      path: `/connectors/github/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs GitHub to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not enable auth-code authorization for device-auth OAuth connectors", async () => {
    detachedSetupPage({
      context,
      path: `/connectors/test-oauth-device/authorize?agentId=${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Test OAuth Device (internal) to proceed"),
      ).toBeInTheDocument();
    });

    expect(getButtonByText("Authorize Zero")).toBeDisabled();
  });
});
