import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorOauthStartContract,
  connectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
  type CustomConnectorOAuthConfig,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  listAgent,
  mcpCustomConnector,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000051";
const PROGRESS = "Connecting your account";

function connectedAccount(
  target: ConnectorAccountTarget,
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target,
    authMethod: "oauth",
    displayName: null,
    isDefault: true,
    externalId: null,
    externalUsername: "alice",
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function authorizationWindow(): Window {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  return popup;
}

test.each(["auth-code", "openid-auth"] as const)(
  "Keep %s progress through permissions and account naming preparation",
  async (grantKind) => {
    const account = connectedAccount({
      kind: "builtin",
      connectorSlug: "stripe",
    });
    const permissions = context.mocks.deferred<void>();
    const permissionRequest = context.mocks.deferred<void>();
    const details = context.mocks.deferred<void>();
    const detailRequest = context.mocks.deferred<void>();
    let authorized = false;
    let granting = false;
    mockConnectors(context, []);
    context.mocks.data.agents([listAgent(AGENT_ID, "Research")]);
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        singleAuthCodeAuthMethodId: grantKind === "auth-code" ? "oauth" : null,
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind,
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const popup = authorizationWindow();
    const start = {
      authorizationUrl: "https://oauth.test/stripe/authorize",
      connectionId: account.id,
    };
    context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
      return respond(200, start);
    });
    context.mocks.api(connectorOpenIdStartContract.start, ({ respond }) => {
      return respond(200, start);
    });
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledConnectorSlugs: granting ? ["stripe"] : [],
      });
    });
    context.mocks.api(userConnectorsContract.update, async ({ respond }) => {
      granting = true;
      permissionRequest.resolve();
      await permissions.promise;
      return respond(200, { enabledConnectorSlugs: ["stripe"] });
    });
    context.mocks.api(
      connectorAccountsContract.connection,
      async ({ respond }) => {
        if (!authorized) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Not connected" },
          });
        }
        if (granting) {
          detailRequest.resolve();
          await details.promise;
        }
        return respond(200, account);
      },
    );
    await setupPage({ context, path: "/connectors?keywords=stripe" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    });
    click(connect);
    await expect(screen.findByText(PROGRESS)).resolves.toBeVisible();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });

    authorized = true;
    context.mocks.data.connectors([{ ...account, slug: "stripe" }]);
    popup.close();
    await permissionRequest.promise;
    expect(screen.getByText(PROGRESS)).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Name your Stripe account" }),
    ).toBeNull();
    permissions.resolve();
    await detailRequest.promise;
    expect(screen.getByText(PROGRESS)).toBeVisible();
    await waitFor(() => {
      return expect(
        getConnectorAction("button", "Manage Stripe accounts"),
      ).toBeDisabled();
    });
    details.resolve();
    const naming = await screen.findByRole("dialog", {
      name: "Name your Stripe account",
    });
    expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      "alice",
    );
    await waitFor(() => {
      return expect(screen.queryByText(PROGRESS)).toBeNull();
    });
    click(getConnectorAction("button", "Skip", naming));
    await waitFor(() => {
      return expect(
        getConnectorAction("button", "Manage Stripe accounts"),
      ).toBeEnabled();
    });
  },
);

test.each(["http", "mcp", "automatic"] as const)(
  "Keep custom %s progress after closing authorization and until naming is ready",
  async (kind) => {
    const oauthConfig: CustomConnectorOAuthConfig = {
      providerAdapter: "standard",
      clientId: "acme-client",
      authorizationUrl: "https://oauth.acme.test/authorize",
      tokenUrl: "https://oauth.acme.test/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "none",
      scopes: ["search.read"],
      authorizationParams: {},
    };
    let connector =
      kind === "http"
        ? customConnector({
            authMode: "oauth",
            oauthConfig,
            fields: [],
            missingRequiredFields: ["oauth"],
          })
        : mcpCustomConnector({
            ...(kind === "automatic"
              ? { authMode: "automatic" }
              : { authMode: "oauth", oauthConfig }),
            connected: false,
            fields: [],
            missingRequiredFields: ["oauth"],
            configuredFieldKeys: [],
          });
    const account = connectedAccount({
      kind: "custom",
      customConnectorId: connector.id,
    });
    const confirmation = context.mocks.deferred<void>();
    const confirmRequest = context.mocks.deferred<void>();
    const details = context.mocks.deferred<void>();
    const detailRequest = context.mocks.deferred<void>();
    let authorized = false;
    let granting = false;
    context.mocks.data.agents([listAgent(AGENT_ID, "Research")]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: authorized
          ? [
              {
                target: account.target,
                accountCount: 1,
                attentionCount: 0,
                defaultConnection: account,
              },
            ]
          : [],
      });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, { grants: [] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, respond }) => {
        granting = true;
        return respond(200, { grants: body.grants });
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      async ({ respond }) => {
        if (!authorized) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Not connected" },
          });
        }
        if (granting) {
          detailRequest.resolve();
          await details.promise;
        } else {
          confirmRequest.resolve();
          await confirmation.promise;
        }
        return respond(200, account);
      },
    );
    const popup = authorizationWindow();
    const start = {
      result: "authorization" as const,
      authorizationUrl: "https://oauth.test/custom/authorize",
      connectionId: account.id,
    };
    context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
      return respond(200, start);
    });
    await setupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });
    const connect = await waitFor(() => {
      return getConnectorAction("button", `Connect ${connector.displayName}`);
    });
    click(connect);
    await expect(screen.findByText(PROGRESS)).resolves.toBeVisible();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    authorized = true;
    connector = {
      ...connector,
      connected: true,
      connectedAccountId: account.id,
      missingRequiredFields: [],
    };
    popup.close();
    await confirmRequest.promise;
    expect(screen.getByText(PROGRESS)).toBeVisible();
    confirmation.resolve();
    await detailRequest.promise;
    expect(screen.getByText(PROGRESS)).toBeVisible();
    expect(
      screen.queryByRole("dialog", {
        name: `Name your ${connector.displayName} account`,
      }),
    ).toBeNull();
    details.resolve();
    const naming = await screen.findByRole("dialog", {
      name: `Name your ${connector.displayName} account`,
    });
    expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      "alice",
    );
    await waitFor(() => {
      return expect(screen.queryByText(PROGRESS)).toBeNull();
    });
  },
);
