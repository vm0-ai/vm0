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
import userEvent from "@testing-library/user-event";
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
  queryConnectorAction,
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

async function expectProgressDialog(name = PROGRESS): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name });
  await expect(within(dialog).findByRole("status")).resolves.toHaveTextContent(
    "Please wait while we finish setting up your connection.",
  );
  await waitFor(() => {
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  });
  expect(within(dialog).getByLabelText("Close")).toBeEnabled();
  return dialog;
}

async function dismissProgress(
  dialog: HTMLElement,
  method: "Close" | "Escape" | "backdrop",
): Promise<void> {
  const user = userEvent.setup();
  if (method === "Close") {
    await user.click(within(dialog).getByLabelText("Close"));
  } else if (method === "Escape") {
    await user.keyboard("{Escape}");
  } else {
    const overlay = dialog.parentElement?.querySelector(
      '[data-slot="dialog-overlay"]',
    );
    if (!(overlay instanceof HTMLElement)) {
      throw new Error("Expected the connection dialog backdrop");
    }
    await user.click(overlay);
  }
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

test.each([
  { grantKind: "auth-code", existing: false, dismiss: null },
  { grantKind: "openid-auth", existing: false, dismiss: null },
  { grantKind: "auth-code", existing: true, dismiss: null },
  { grantKind: "auth-code", existing: true, dismiss: "Close" },
  { grantKind: "auth-code", existing: false, dismiss: "Close" },
  { grantKind: "auth-code", existing: false, dismiss: "Escape" },
  { grantKind: "auth-code", existing: false, dismiss: "backdrop" },
] as const)(
  "Track $grantKind through naming (existing dialog: $existing, dismissal: $dismiss)",
  async ({ grantKind, existing, dismiss }) => {
    const dialogName = existing ? "Stripe" : PROGRESS;
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
        singleAuthCodeAuthMethodId:
          !existing && grantKind === "auth-code" ? "oauth" : null,
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind,
            manualFields: [],
            startOptions: [],
          },
          ...(existing
            ? [
                {
                  id: "api-token",
                  label: "API token",
                  description: null,
                  grantKind: "manual" as const,
                  manualFields: [],
                  startOptions: [],
                },
              ]
            : []),
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
    if (existing) {
      const chooser = await screen.findByRole("dialog", { name: "Stripe" });
      click(getConnectorAction("button", "Connect", chooser));
    }
    const progress = await expectProgressDialog(dialogName);
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    if (dismiss) {
      await dismissProgress(progress, dismiss);
    }
    expect(popup.closed).toBeFalsy();
    expect(connect).toBeDisabled();

    authorized = true;
    context.mocks.data.connectors([{ ...account, slug: "stripe" }]);
    popup.close();
    await permissionRequest.promise;
    expect(screen.queryAllByRole("dialog", { name: dialogName })).toHaveLength(
      dismiss ? 0 : 1,
    );
    expect(
      screen.queryByRole("dialog", { name: "Name your Stripe account" }),
    ).toBeNull();
    permissions.resolve();
    await detailRequest.promise;
    expect(screen.queryAllByRole("dialog", { name: dialogName })).toHaveLength(
      dismiss ? 0 : 1,
    );
    expect(queryConnectorAction("button", "Manage Stripe accounts")).toBeNull();
    details.resolve();
    const naming = await screen.findByRole("dialog", {
      name: "Name your Stripe account",
    });
    expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      "alice",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: PROGRESS })).toBeNull();
      expect(within(naming).getByLabelText("Account name")).toHaveFocus();
    });
    click(getConnectorAction("button", "Skip", naming));
    await waitFor(() => {
      return expect(
        getConnectorAction("button", "Manage Stripe accounts"),
      ).toBeEnabled();
    });
  },
);

test("Show progress for a new connection after dismissing the previous attempt", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Stripe",
      singleAuthCodeAuthMethodId: "oauth",
      authMethods: [
        {
          id: "oauth",
          label: "OAuth",
          description: null,
          grantKind: "auth-code",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  const authorizationUrl = "https://oauth.test/stripe/authorize";
  context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl });
  });
  const firstPopup = authorizationWindow();
  await setupPage({ context, path: "/connectors?keywords=stripe" });
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect Stripe");
  });
  click(connect);
  const progress = await expectProgressDialog();
  await waitFor(() => {
    expect(firstPopup.location.href).toBe(authorizationUrl);
  });
  await dismissProgress(progress, "Close");
  expect(firstPopup.closed).toBeFalsy();
  firstPopup.close();
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  const nextPopup = authorizationWindow();
  click(connect);
  await expectProgressDialog();
  await waitFor(() => {
    expect(nextPopup.location.href).toBe(authorizationUrl);
  });
  nextPopup.close();
  await waitFor(() => {
    expect(connect).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

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
    await expectProgressDialog();
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
    expect(screen.getByRole("dialog", { name: PROGRESS })).toBeVisible();
    confirmation.resolve();
    await detailRequest.promise;
    expect(screen.getByRole("dialog", { name: PROGRESS })).toBeVisible();
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
      expect(screen.queryByRole("dialog", { name: PROGRESS })).toBeNull();
      expect(within(naming).getByLabelText("Account name")).toHaveFocus();
    });
  },
);
