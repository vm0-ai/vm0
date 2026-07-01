import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
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
    reconnectReason: null,
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

function mockConnectorOauthStart(): { readonly authWindow: Window } {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    zeroConnectorOauthStartContract.start,
    ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    },
  );
  context.mocks.browser.open(authWindow);
  return { authWindow };
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

  it("does not authorize the agent when OAuth connection is cancelled", async () => {
    const { authWindow } = mockConnectorOauthStart();
    let updateCalls = 0;
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    });
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ body, respond }) => {
        updateCalls += 1;
        return respond(200, { enabledTypes: body.enabledTypes });
      },
    );

    detachedSetupPage({
      context,
      path: `/connectors/github/authorize?agentId=${AGENT_ID}`,
    });

    await screen.findByText("Zero needs GitHub to proceed");
    click(getButtonByText("Authorize Zero"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
    await screen.findByText("Connecting...");

    authWindow.close();

    await screen.findByText("Authorize Zero");
    expect(updateCalls).toBe(0);
    expect(screen.queryByText("GitHub authorized")).not.toBeInTheDocument();
  });
});
