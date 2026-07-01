import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
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

function publicStatusItem(args: {
  readonly connectorRef: ConnectorType;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly connection?: PublicConnectorCatalogStatusItem["connection"];
  readonly connected?: boolean;
  readonly singleAuthCodeAuthMethodId?: string | null;
}): PublicConnectorCatalogStatusItem {
  const connected = args.connected ?? false;
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: args.description ?? `${args.label} public description`,
    category: args.category ?? "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: args.authMethods,
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: args.connection ?? null,
    connected,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId ?? null,
    connectNotice: null,
  };
}

function mockPublicConnectorStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

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
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    let submittedValues: Record<string, string> | null = null;
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.type).toBe("axiom");
        submittedValues = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          type: "axiom",
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/authorize?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });

    click(getButtonByText("Authorize Zero"));

    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-directed-authorize",
    );
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual({
        apiToken: "xaat-directed-authorize",
      });
      expect(screen.getByText("Public Axiom authorized")).toBeInTheDocument();
      expect(screen.getByText("Authorized")).toBeInTheDocument();
    });
  });

  it("opens the connect dialog when catalog does not expose direct OAuth", async () => {
    let startCalls = 0;
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        startCalls += 1;
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.type}/authorize`,
        });
      },
    );
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "github",
        label: "Public GitHub",
        authMethods: [
          {
            id: "oauth",
            label: "Public OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
        ],
        singleAuthCodeAuthMethodId: null,
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/connectors/github/authorize?agentId=${AGENT_ID}`,
    });

    await screen.findByText("Zero needs Public GitHub to proceed");
    click(getButtonByText("Authorize Zero"));

    await screen.findByRole("dialog", { name: "Public GitHub" });
    expect(startCalls).toBe(0);
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
        return respond(200, {
          enabledTypes: body.operation === "remove" ? [] : body.enabledTypes,
        });
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
