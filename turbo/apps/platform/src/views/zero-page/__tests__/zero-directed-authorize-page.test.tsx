import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function connectorResponse(type: ConnectorType): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: ["repo", "read:user"],
    connectionStatus: "connected",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mockConnectedConnector(type: ConnectorType): void {
  context.mocks.data.connectors([connectorResponse(type)]);
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("directed connector authorize page", () => {
  it("authorizes a connected connector and recognizes existing authorization", async () => {
    mockConnectedConnector("gmail");

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
      expect(screen.getByText("Authorized")).toBeInTheDocument();
    });
  });

  it("starts in the authorized state when the agent already has access", async () => {
    mockConnectedConnector("gmail");
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["gmail"] });
    });

    detachedSetupPage({
      context,
      path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
      expect(screen.getByText("Authorized")).toBeInTheDocument();
    });
    expect(screen.queryByText("Authorize Zero")).not.toBeInTheDocument();
  });

  it("does not expose authorization actions for unusable links", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/nonexistent/authorize",
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Authorize/)).not.toBeInTheDocument();
  });

  it("normalizes connector casing and shows Google consent before connection", async () => {
    detachedSetupPage({
      context,
      path: `/connectors/Gmail/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
  });

  it("opens the device-auth method picker when authorization needs a connection", async () => {
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

    click(getButtonByText("Authorize Zero"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test OAuth Device (internal)" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("OAuth Device Authorization"),
      ).toBeInTheDocument();
    });
  });

  it("opens the multi-method picker when authorization needs a configurable connector", async () => {
    detachedSetupPage({
      context,
      path: `/connectors/stripe/authorize?agentId=${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Stripe to proceed"),
      ).toBeInTheDocument();
    });

    click(getButtonByText("Authorize Zero"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Stripe" }),
      ).toBeInTheDocument();
      expect(screen.getByText("OAuth (Recommended)")).toBeInTheDocument();
      expect(screen.getAllByText("API Key").length).toBeGreaterThan(0);
    });
  });

  it("connects a manual-token connector before authorizing the agent", async () => {
    detachedSetupPage({
      context,
      path: `/connectors/axiom/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Axiom to proceed"),
      ).toBeInTheDocument();
    });

    click(getButtonByText("Authorize Zero"));

    const axiomDialog = await screen.findByRole("dialog", { name: "Axiom" });
    await fill(
      within(axiomDialog).getByPlaceholderText("xaat-..."),
      "xaat-directed-authorize",
    );
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Axiom authorized")).toBeInTheDocument();
      expect(screen.getByText("Authorized")).toBeInTheDocument();
    });
  });
});
