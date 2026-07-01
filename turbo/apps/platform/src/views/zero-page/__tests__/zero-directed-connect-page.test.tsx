import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
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

function mockPublicConnectorStatus(
  connector: PublicConnectorCatalogStatusItem,
): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
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

describe("directed connector connect page", () => {
  it("starts an OAuth flow from a directed link", async () => {
    const { authWindow } = mockConnectorOauthStart();
    mockPublicConnectorStatus({
      connectorRef: "github",
      label: "Public GitHub",
      description: "Public GitHub description",
      category: "engineering-team-execution",
      generation: [],
      tags: [],
      authMethods: [
        {
          id: "oauth",
          label: "Public OAuth",
          description: "Public OAuth description",
          grantKind: "auth-code",
          manualFields: [],
          startOptions: [],
        },
      ],
      permissionSummary: {
        hasPermissions: false,
        permissionCount: 0,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
      connection: null,
      connected: false,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: "oauth",
      connectNotice: null,
    });

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public GitHub to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
  });

  it("waits for manual grant agent authorization before closing", async () => {
    mockPublicConnectorStatus({
      connectorRef: "axiom",
      label: "Public Axiom",
      description: "Public Axiom description",
      category: "data-automation-infrastructure",
      generation: [],
      tags: [],
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
      permissionSummary: {
        hasPermissions: false,
        permissionCount: 0,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
      connection: null,
      connected: false,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
    });
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
    const authorizationResponse = Promise.withResolvers<void>();
    let authorizedAgentId: string | null = null;
    context.mocks.api(
      zeroUserConnectorsContract.update,
      async ({ body, params, respond }) => {
        authorizedAgentId = params.id;
        expect(body).toStrictEqual({
          enabledTypes: ["axiom"],
          operation: "add",
        });
        await authorizationResponse.promise;
        return respond(200, { enabledTypes: body.enabledTypes });
      },
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-directed-connect",
    );
    click(getButtonByText("Save"));

    try {
      await waitFor(() => {
        expect(submittedValues).toStrictEqual({
          apiToken: "xaat-directed-connect",
        });
        expect(authorizedAgentId).toBe(AGENT_ID);
      });
      expect(
        screen.getByRole("dialog", { name: "Public Axiom" }),
      ).toBeInTheDocument();
    } finally {
      authorizationResponse.resolve();
    }

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Public Axiom" }),
      ).not.toBeInTheDocument();
    });
  });
});
