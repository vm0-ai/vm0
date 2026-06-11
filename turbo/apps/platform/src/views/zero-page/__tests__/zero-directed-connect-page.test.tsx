import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function connectorResponse(
  type: ConnectorType,
  authMethod: ConnectorResponse["authMethod"] = "oauth",
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: authMethod === "oauth" ? ["repo", "read:user"] : null,
    connectionStatus: "connected",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function manualGrantConnectorResponse(type: ConnectorType): ConnectorResponse {
  return connectorResponse(type, "api-token");
}

function mockConnectedConnectors(
  connectors: readonly {
    readonly type: ConnectorType;
    readonly authMethod?: ConnectorResponse["authMethod"];
  }[],
): void {
  context.mocks.data.connectors(
    connectors.map((connector) => {
      return connectorResponse(connector.type, connector.authMethod);
    }),
  );
}

function mockConnectorOauthStart(): { readonly authWindow: Window } {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
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

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

async function findDeviceAuthConnectButton(): Promise<HTMLElement> {
  await screen.findByRole("heading", {
    name: "Test OAuth Device (internal)",
  });
  const button = queryAllByRoleFast("button").find((element) => {
    return (
      element.textContent?.trim() === "Connect Test OAuth Device (internal)"
    );
  });
  if (!button) {
    throw new Error("Test OAuth device connect button not found");
  }
  return button;
}

describe("directed connector connect page", () => {
  it("shows only usable directed links and relevant consent warnings", async () => {
    detachedSetupPage({ context, path: "/connectors/Gmail/connect" });

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

  it("does not show an actionable card for an unknown connector link", async () => {
    detachedSetupPage({ context, path: "/connectors/nonexistent/connect" });

    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("starts an OAuth flow from a directed link", async () => {
    const { authWindow } = mockConnectorOauthStart();

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs GitHub to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
  });

  it("submits manual credentials from a directed link and surfaces failures", async () => {
    const user = userEvent.setup();
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, respond }) => {
        if (body.values.AXIOM_TOKEN === "bad-token") {
          return respond(401, {
            error: { message: "Invalid manual grant", code: "UNAUTHORIZED" },
          });
        }
        return respond(200, manualGrantConnectorResponse("axiom"));
      },
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Axiom to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText("xaat-..."), "   ");
    expect(getButtonByText("Save")).toBeDisabled();

    await fill(screen.getByPlaceholderText("xaat-..."), "bad-token");
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Invalid manual grant")).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("xaat-..."), "test-token");
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Axiom connected")).toBeInTheDocument();
    });
  });

  it("opens method choice surfaces for device-auth and multi-method connectors", async () => {
    detachedSetupPage({
      context,
      path: `/connectors/test-oauth-device/connect?agentId=${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Test OAuth Device (internal) to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await expect(findDeviceAuthConnectButton()).resolves.toBeInTheDocument();
  });

  it("opens the method picker for a connector with OAuth and API key options", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/stripe/connect",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Stripe to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Stripe" }),
      ).toBeInTheDocument();
      expect(screen.getByText("OAuth (Recommended)")).toBeInTheDocument();
      expect(screen.getAllByText("API Key").length).toBeGreaterThan(0);
    });
  });

  it("shows reconnect actions for already connected directed links", async () => {
    mockConnectorOauthStart();
    mockConnectedConnectors([{ type: "github" }]);

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
      expect(getButtonByText("Reconnect")).toBeInTheDocument();
    });
  });
});
