import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { beforeEach, describe, expect, it } from "vitest";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockAgent,
  mockAgentConnectorAuthorizations,
  mockConnectors,
  mockOrgModelRoutes,
  composerElementFrom,
} from "./chat-composer-test-helpers.ts";

function connectorStatus({
  connectorRef: connectorSlug,
  label,
  authMethods,
  singleAuthCodeAuthMethodId = null,
}: {
  readonly connectorRef: PublicConnectorCatalogStatusItem["connectorRef"];
  readonly label: string;
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly singleAuthCodeAuthMethodId?: string | null;
}): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: connectorSlug,
    label,
    description: `Connect ${label}`,
    icon: {
      url: `https://icons.example.test/${connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods,
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
    singleAuthCodeAuthMethodId,
    connectNotice: null,
  };
}

function customConnector(
  overrides: Partial<CustomConnectorResponse> = {},
): CustomConnectorResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "_acme-search",
    displayName: "Acme Search",
    prefixes: ["https://api.acme.test/v1/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    hasSecret: false,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function mockCatalog(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function createMockAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  return authWindow;
}

async function openAddConnectorsDialog(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const composer = composerElementFrom(
    await screen.findByPlaceholderText(PLACEHOLDER),
  );
  await user.click(within(composer).getByLabelText("Connectors"));
  await user.click(await screen.findByText("Add connectors"));
  return await screen.findByRole("dialog", {
    name: "Available connectors to connect (1)",
  });
}

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  mockConnectors([]);
  mockAgentConnectorAuthorizations([]);
});

describe("chat composer connector connection", () => {
  it("shows connected custom connectors and toggles agent access", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
      hasSecret: true,
    });
    context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    let enabledIds: string[] = [];
    context.mocks.api(
      zeroAgentCustomConnectorsContract.get,
      ({ params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, { enabledIds });
      },
    );
    let updateCount = 0;
    context.mocks.api(
      zeroAgentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        updateCount += 1;
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledIds: [connector.id],
          operation: "add",
        });
        enabledIds = [connector.id];
        return respond(200, { enabledIds });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Add Acme Search"));

    await waitFor(() => {
      expect(updateCount).toBe(1);
      expect(screen.getByLabelText("Remove Acme Search")).toBeInTheDocument();
    });
  });

  it("connects a custom connector for only the active agent", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = customConnector();
    mockAgent({ includeOtherAgent: true });
    mockCatalog([]);
    let connected = false;
    context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          connected
            ? {
                ...connector,
                connected: true,
                missingRequiredFields: [],
                configuredFieldKeys: ["secret"],
                hasSecret: true,
              }
            : connector,
        ],
      });
    });
    context.mocks.api(
      zeroCustomConnectorSecretContract.set,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body).toStrictEqual({ value: "acme-secret" });
        connected = true;
        return respond(204);
      },
    );
    const updatedAgentIds: string[] = [];
    context.mocks.api(
      zeroAgentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(body).toStrictEqual({
          enabledIds: [connector.id],
          operation: "add",
        });
        updatedAgentIds.push(params.id);
        return respond(200, { enabledIds: [connector.id] });
      },
    );
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const dialog = await openAddConnectorsDialog(user);
    await user.click(
      within(dialog).getByLabelText(`Connect ${connector.displayName}`),
    );

    const connectDialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    expect(dialog).not.toBeInTheDocument();
    await user.type(
      within(connectDialog).getByLabelText("Secret"),
      "acme-secret",
    );
    const saveButton = queryAllByRoleFast("button", connectDialog).find(
      (button) => {
        return button.textContent === "Save";
      },
    );
    if (!saveButton) {
      throw new Error("Save button not found");
    }
    await user.click(saveButton);

    await waitFor(() => {
      expect(updatedAgentIds).toStrictEqual([AGENT_ID]);
      expect(connectDialog).not.toBeInTheDocument();
    });
  });

  it("starts a single OAuth connector without an intermediate modal", async () => {
    const user = userEvent.setup({ delay: null });
    mockCatalog([
      connectorStatus({
        connectorRef: "google-analytics",
        label: "Google Analytics",
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
        singleAuthCodeAuthMethodId: "oauth",
      }),
    ]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("google-analytics");
        expect(body.agentId).toBe(AGENT_ID);
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/analytics/authorize",
        });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const dialog = await openAddConnectorsDialog(user);
    const connectorCard = within(dialog).getByLabelText(
      "Connect Google Analytics",
    );
    await user.click(connectorCard);

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://accounts.google.test/analytics/authorize",
      );
    });
    expect(
      screen.queryByRole("dialog", { name: "Google Analytics" }),
    ).not.toBeInTheDocument();
  });

  it("enables a single no-auth connector without an intermediate modal", async () => {
    const user = userEvent.setup({ delay: null });
    mockCatalog([
      connectorStatus({
        connectorRef: "stripe",
        label: "Public Stripe",
        authMethods: [
          {
            id: "api",
            label: "Public catalog",
            description: null,
            grantKind: "none",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    let connectCount = 0;
    context.mocks.api(
      zeroConnectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCount += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body).toStrictEqual({
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, {
          id: crypto.randomUUID(),
          type: params.connectorSlug,
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    let authorizationUpdateCount = 0;
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ body, params, respond }) => {
        authorizationUpdateCount += 1;
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledTypes: ["stripe"],
          operation: "add",
        });
        return respond(200, { enabledTypes: ["stripe"] });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const dialog = await openAddConnectorsDialog(user);
    await user.click(within(dialog).getByLabelText("Connect Public Stripe"));

    await waitFor(() => {
      expect(connectCount).toBe(1);
      expect(authorizationUpdateCount).toBe(1);
      expect(
        screen.queryByRole("dialog", {
          name: "Available connectors to connect (1)",
        }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("dialog", { name: "Public Stripe" }),
    ).not.toBeInTheDocument();
  });

  it("opens the connection modal when connector configuration is required", async () => {
    const user = userEvent.setup({ delay: null });
    mockCatalog([
      connectorStatus({
        connectorRef: "axiom",
        label: "Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "API token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "API token",
                required: true,
                placeholder: "xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const dialog = await openAddConnectorsDialog(user);
    await user.click(within(dialog).getByLabelText("Connect Axiom"));

    await expect(
      screen.findByRole("dialog", { name: "Axiom" }),
    ).resolves.toBeInTheDocument();
  });
});
