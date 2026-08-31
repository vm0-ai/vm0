import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorValuesContract,
  customConnectorsContract,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  connectorNoAuthGrantContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { beforeEach, describe, expect, it } from "vitest";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectField$,
} from "../../../signals/okou-page/settings/custom-connectors.ts";
import {
  fillComposer,
  mockChatLifecycle,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  mockAgent,
  mockAgentConnectorAuthorizations,
  mockConnectors,
  mockOrgModelRoutes,
  mockThread,
  composerElementFrom,
} from "./chat-composer-test-helpers.ts";

function connectorStatus({
  slug: connectorSlug,
  label,
  authMethods,
  singleAuthCodeAuthMethodId = null,
}: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly singleAuthCodeAuthMethodId?: string | null;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: connectorSlug,
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

function buttonByText(text: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function customConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return {
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    storageVersion: 1,
    slug: "_acme-search",
    displayName: "Acme Search",
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
    authMode: "manual",
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function managedFeishuConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return customConnector({
    id: "55555555-5555-4555-8555-555555555555",
    slug: "_feishu-00000000-0000-4000-8000-000000000055",
    displayName: "Feishu",
    prefixTemplates: ["https://open.feishu.cn/open-apis/"],
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    authMode: "oauth",
    permissionBundleRef: "builtin:feishu@1",
    oauthConfig: {
      providerAdapter: "feishu",
      clientId: "cli_feishu",
      authorizationUrl:
        "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "none",
      scopes: ["offline_access", "im:message"],
      authorizationParams: {},
    },
    missingRequiredFields: ["oauth"],
    ...overrides,
  });
}

function mcpCustomConnector(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    storageVersion: 1,
    slug: "_deepwiki",
    displayName: "DeepWiki",
    endpoint: "https://mcp.deepwiki.com/mcp",
    transport: "streamable-http",
    prefixTemplates: [],
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
        name: "X-VM0-Test-Token",
        valueTemplate: "{{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    permissionBundleRef: null,
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function mockCatalog(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(200, {
      connectors: [...connectors],
      totalConnectorCount: connectors.length,
    });
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

function githubAccount(
  id: string,
  displayName: string,
  isDefault: boolean,
): ConnectorAccountConnection {
  return {
    id,
    target: { kind: "builtin", connectorSlug: "github" },
    authMethod: "oauth",
    displayName,
    isDefault,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function customAccount(
  id: string,
  customConnectorId: string,
  displayName: string,
  isDefault: boolean,
): ConnectorAccountConnection {
  return {
    ...githubAccount(id, displayName, isDefault),
    target: { kind: "custom", customConnectorId },
    authMethod: "manual",
  };
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
  context.store.set(resetCustomConnectorConnectInput$);
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  mockConnectors([]);
  mockAgentConnectorAuthorizations([]);
});

describe("chat composer connector connection", () => {
  it("loads connector data only after the connector menu is opened", async () => {
    const user = userEvent.setup({ delay: null });
    let discoveryRequests = 0;
    let customConnectorRequests = 0;
    mockThread();
    context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
      discoveryRequests += 1;
      return respond(200, { connectors: [], totalConnectorCount: 0 });
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      customConnectorRequests += 1;
      return respond(200, { connectors: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    expect(discoveryRequests).toBe(0);
    expect(customConnectorRequests).toBe(0);

    await user.click(within(composer).getByLabelText("Connectors"));

    await waitFor(() => {
      expect(discoveryRequests).toBe(1);
      expect(customConnectorRequests).toBe(1);
      expect(within(composer).getByLabelText("Connectors")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
  });

  it("makes connector permissions interactive on the first click", async () => {
    const user = userEvent.setup({ delay: null });
    mockThread();
    mockConnectors([{ connectorSlug: "axiom", authMethod: "api-token" }]);
    mockAgentConnectorAuthorizations(["axiom"]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const connectorsTrigger = () => {
      return within(composer).getByLabelText("Connectors");
    };
    await user.click(connectorsTrigger());
    expect(connectorsTrigger()).toHaveAttribute("aria-expanded", "true");

    await user.click(
      await screen.findByLabelText("Configure Axiom permissions"),
    );

    const permissionsDialog = await screen.findByRole("dialog", {
      name: /Axiom permissions/u,
    });
    await waitFor(() => {
      expect(connectorsTrigger()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Add connectors")).not.toBeInTheDocument();
    });

    const permissionName =
      await within(permissionsDialog).findByText("annotations|create");
    const permissionRow = permissionName.parentElement?.parentElement;
    if (!(permissionRow instanceof HTMLElement)) {
      throw new Error("Expected an Axiom permission row");
    }
    const denyButton = buttonByText("Deny", permissionRow);
    const applyButton = buttonByText("Apply", permissionsDialog);
    expect(denyButton).toHaveAttribute("aria-pressed", "false");
    expect(applyButton).toBeDisabled();

    await user.click(denyButton);

    expect(denyButton).toHaveAttribute("aria-pressed", "true");
    expect(applyButton).toBeEnabled();

    await user.click(buttonByText("Cancel", permissionsDialog));
    await waitFor(() => {
      expect(permissionsDialog).not.toBeInTheDocument();
    });
    expect(connectorsTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("places the account action before connector permissions", async () => {
    const user = userEvent.setup({ delay: null });
    const defaultAccount: ConnectorAccountConnection = {
      ...githubAccount("10000000-0000-4000-8000-000000000004", "Work", true),
      target: { kind: "builtin", connectorSlug: "axiom" },
      authMethod: "api-token",
    };
    mockThread();
    mockConnectors([{ connectorSlug: "axiom", authMethod: "api-token" }]);
    mockAgentConnectorAuthorizations(["axiom"]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: defaultAccount.target,
            accountCount: 2,
            attentionCount: 0,
            defaultConnection: defaultAccount,
          },
        ],
      });
    });
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ respond }) => {
        return respond(200, { selections: [], selectedConnections: [] });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    const accountAction = await screen.findByLabelText(
      "Axiom · Using default account: Work",
    );
    const permissionAction = screen.getByLabelText(
      "Configure Axiom permissions",
    );

    expect(
      accountAction.compareDocumentPosition(permissionAction) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps permissioned connector row height stable while toggling access", async () => {
    const user = userEvent.setup({ delay: null });
    let authorizationWrites = 0;
    let enabledConnectorSlugs = ["axiom"];
    mockThread();
    mockConnectors([{ connectorSlug: "axiom", authMethod: "api-token" }]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs });
    });
    context.mocks.api(userConnectorsContract.update, ({ body, respond }) => {
      expect(body).toStrictEqual({
        enabledConnectorSlugs: ["axiom"],
        operation: "remove",
      });
      authorizationWrites += 1;
      enabledConnectorSlugs = [];
      return respond(200, { enabledConnectorSlugs });
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    const connectorName = await screen.findByText("Axiom");
    const accessLabel = connectorName.closest("label");
    if (!accessLabel?.control) {
      throw new Error("Expected the Axiom label to target its access switch");
    }
    expect(accessLabel.parentElement).toHaveClass("h-10", "shrink-0");
    expect(
      screen.getByLabelText("Configure Axiom permissions").closest("label"),
    ).toBeNull();

    await user.click(connectorName);

    await waitFor(() => {
      expect(authorizationWrites).toBe(1);
    });
    const disconnectedAccess = await screen.findByLabelText("Add Axiom");
    expect(disconnectedAccess.closest("label")?.parentElement).toHaveClass(
      "h-10",
      "shrink-0",
    );
    expect(
      screen.queryByLabelText("Configure Axiom permissions"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /Axiom permissions/u }),
    ).not.toBeInTheDocument();
  });

  it("keeps one-account connector rows unchanged", async () => {
    const user = userEvent.setup({ delay: null });
    const account = githubAccount(
      "10000000-0000-4000-8000-000000000003",
      "Only account",
      true,
    );
    mockThread();
    mockConnectors([{ connectorSlug: "github" }]);
    mockAgentConnectorAuthorizations(["github"]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: account.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: account,
          },
        ],
      });
    });
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ respond }) => {
        return respond(200, { selections: [], selectedConnections: [] });
      },
    );
    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });
    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await expect(
      screen.findByLabelText("Remove GitHub"),
    ).resolves.toBeInTheDocument();
    const accessLabel = screen.getByText("GitHub").closest("label");
    if (!accessLabel?.control) {
      throw new Error("Expected the GitHub label to target its access switch");
    }
    expect(accessLabel.previousElementSibling).toBeNull();
    expect(screen.queryByLabelText(/GitHub ·/u)).not.toBeInTheDocument();
  });

  it("selects a thread account inside the connectors popover", async () => {
    const user = userEvent.setup({ delay: null });
    const defaultAccount = githubAccount(
      "10000000-0000-4000-8000-000000000001",
      "Work",
      true,
    );
    const personalAccount = githubAccount(
      "10000000-0000-4000-8000-000000000002",
      "Personal",
      false,
    );
    let selectedAccount: ConnectorAccountConnection | null = null;
    let authorizationWrites = 0;
    let selectionWrites = 0;
    let selectionClears = 0;
    let summaryReads = 0;
    mockThread();
    mockConnectors([{ connectorSlug: "github" }]);
    mockAgentConnectorAuthorizations(["github"]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      summaryReads += 1;
      return respond(200, {
        summaries: [
          {
            target: { kind: "builtin", connectorSlug: "github" },
            accountCount: 2,
            attentionCount: 0,
            defaultConnection: defaultAccount,
          },
        ],
      });
    });
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        expect(query).toMatchObject({
          kind: "builtin",
          connectorSlug: "github",
          limit: 50,
        });
        return respond(200, {
          connections: [defaultAccount, personalAccount],
          nextCursor: null,
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ params, respond }) => {
        expect(params.id).toBe(THREAD_ID);
        return respond(200, {
          selections: selectedAccount
            ? [
                {
                  connectionId: selectedAccount.id,
                  target: selectedAccount.target,
                },
              ]
            : [],
          selectedConnections: selectedAccount ? [selectedAccount] : [],
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.update,
      ({ body, respond }) => {
        selectionWrites += 1;
        selectedAccount =
          [defaultAccount, personalAccount].find((account) => {
            return account.id === body.connectionId;
          }) ?? null;
        if (!selectedAccount) {
          throw new Error("Expected a known account selection");
        }
        return respond(200, body);
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.clear,
      ({ body, respond }) => {
        selectionClears += 1;
        expect(body).toStrictEqual({
          kind: "builtin",
          connectorSlug: "github",
        });
        selectedAccount = null;
        return respond(204);
      },
    );
    context.mocks.api(userConnectorsContract.update, ({ respond }) => {
      authorizationWrites += 1;
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const connectorsButton = () => {
      return within(composer).getByLabelText("Connectors");
    };
    await user.click(connectorsButton());
    const defaultMode = await screen.findByLabelText(
      "GitHub · Using default account: Work",
    );
    expect(defaultMode).toHaveClass("text-muted-foreground");
    expect(defaultMode).not.toHaveClass("border");
    const connectorName = screen.getByText("GitHub");
    const accessLabel = connectorName.closest("label");
    if (!accessLabel?.control) {
      throw new Error("Expected the GitHub label to target its access switch");
    }
    expect(defaultMode.closest("label")).toBeNull();
    expect(
      defaultMode.compareDocumentPosition(accessLabel.control) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(connectorName);
    await waitFor(() => {
      expect(authorizationWrites).toBe(1);
    });
    expect(screen.queryByText("Use default")).not.toBeInTheDocument();

    await user.click(defaultMode);
    await expect(
      screen.findByText("Account for this chat"),
    ).resolves.toBeVisible();
    await user.click(screen.getByLabelText("Back"));
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");

    await user.click(defaultMode);
    await expect(
      screen.findByText("Account for this chat"),
    ).resolves.toBeVisible();
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");

    await user.click(defaultMode);
    await expect(
      screen.findByText("Account for this chat"),
    ).resolves.toBeVisible();
    const summaryReadsBeforeSelection = summaryReads;
    expect(screen.getByText("GitHub")).toBeVisible();
    expect(
      queryAllByRoleFast("button").find((button) => {
        return button.textContent?.trim() === "Add connectors";
      }),
    ).toBeVisible();
    await expect(screen.findByText("Use default")).resolves.toBeInTheDocument();
    const defaultRadio = screen.getByRole("radio", {
      name: /Use default/u,
    });
    defaultRadio.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(selectionWrites).toBe(1);
    });
    const selectedWorkMode = await screen.findByLabelText(
      "GitHub · Selected account: Work",
    );
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");
    expect(selectedWorkMode).toHaveClass("text-muted-foreground");
    expect(selectedWorkMode).not.toHaveClass("border");

    await user.click(selectedWorkMode);
    await expect(
      screen.findByText("Account for this chat"),
    ).resolves.toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");
    expect(selectedWorkMode).toHaveFocus();

    await user.click(selectedWorkMode);
    await user.click(screen.getByRole("radio", { name: /Personal/u }));
    await waitFor(() => {
      expect(selectionWrites).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");
    await expect(
      screen.findByLabelText("GitHub · Selected account: Personal"),
    ).resolves.toHaveClass("text-muted-foreground");

    await user.click(
      screen.getByLabelText("GitHub · Selected account: Personal"),
    );
    await user.click(screen.getByRole("radio", { name: /Use default/u }));
    await waitFor(() => {
      expect(selectionClears).toBe(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    await expect(
      screen.findByLabelText("GitHub · Using default account: Work"),
    ).resolves.toBeInTheDocument();
    expect(connectorsButton()).toHaveAttribute("aria-expanded", "true");
    expect(authorizationWrites).toBe(1);
    expect(summaryReads).toBe(summaryReadsBeforeSelection);

    await user.click(document.body);
    await waitFor(() => {
      expect(connectorsButton()).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("keeps the selected account visible when search has no matches", async () => {
    const user = userEvent.setup({ delay: null });
    const defaultAccount = githubAccount(
      "10000000-0000-4000-8000-000000000021",
      "Work",
      true,
    );
    const personalAccount = githubAccount(
      "10000000-0000-4000-8000-000000000022",
      "Personal",
      false,
    );
    const requestedSearches: string[] = [];
    mockThread();
    mockConnectors([{ connectorSlug: "github" }]);
    mockAgentConnectorAuthorizations(["github"]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: defaultAccount.target,
            accountCount: 7,
            attentionCount: 0,
            defaultConnection: defaultAccount,
          },
        ],
      });
    });
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        requestedSearches.push(query.search ?? "");
        return respond(200, {
          connections: query.search ? [] : [defaultAccount, personalAccount],
          nextCursor: null,
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ respond }) => {
        return respond(200, {
          selections: [
            {
              connectionId: personalAccount.id,
              target: personalAccount.target,
            },
          ],
          selectedConnections: [personalAccount],
        });
      },
    );
    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(
      await screen.findByLabelText("GitHub · Selected account: Personal"),
    );
    await user.type(screen.getByPlaceholderText("Find accounts"), "missing");

    await expect(screen.findByText("No accounts found")).resolves.toBeVisible();
    expect(
      screen.getByRole("radio", { name: /Personal/u }),
    ).toBeInTheDocument();
    expect(requestedSearches).toStrictEqual(["", "missing"]);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Account for this chat")).toBeNull();
    });
    expect(requestedSearches).toStrictEqual(["", "missing"]);
  });

  it("applies a pending account selection when creating a thread", async () => {
    const user = userEvent.setup({ delay: null });
    const defaultAccount = githubAccount(
      "10000000-0000-4000-8000-000000000011",
      "Work",
      true,
    );
    const personalAccount = githubAccount(
      "10000000-0000-4000-8000-000000000012",
      "Personal",
      false,
    );
    let createdSelections: readonly ConnectorAccountSelection[] | undefined;
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdSelections = body.connectorSelections;
      },
    });
    mockConnectors([{ connectorSlug: "github" }]);
    mockAgentConnectorAuthorizations(["github"]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: defaultAccount.target,
            accountCount: 2,
            attentionCount: 0,
            defaultConnection: defaultAccount,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, {
        connections: [defaultAccount, personalAccount],
        nextCursor: null,
      });
    });
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    const composer = composerElementFrom(input);
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(
      await screen.findByLabelText("GitHub · Using default account: Work"),
    );
    await user.click(screen.getByRole("radio", { name: /Personal/u }));
    await user.keyboard("{Escape}");
    await fillComposer(input, "Use my personal GitHub account");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(createdSelections).toStrictEqual([
        {
          connectionId: personalAccount.id,
          target: personalAccount.target,
        },
      ]);
    });
  });

  it("authorizes connector access for the thread agent", async () => {
    const user = userEvent.setup({ delay: null });
    mockThread();
    mockConnectors([{ connectorSlug: "github" }]);
    const updatedAgentIds: string[] = [];
    let enabledConnectorSlugs: string[] = [];
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      return respond(200, { enabledConnectorSlugs });
    });
    context.mocks.api(
      userConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(body).toStrictEqual({
          enabledConnectorSlugs: ["github"],
          operation: "add",
        });
        updatedAgentIds.push(params.id);
        enabledConnectorSlugs = ["github"];
        return respond(200, { enabledConnectorSlugs });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Add GitHub"));

    await waitFor(() => {
      expect(updatedAgentIds).toStrictEqual([AGENT_ID]);
      expect(screen.getByLabelText("Remove GitHub")).toBeInTheDocument();
    });
  });

  it("shows connected MCP custom connectors and toggles agent access", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = mcpCustomConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    let grants: AgentCustomConnectorGrant[] = [];
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, { grants });
      },
    );
    let updateCount = 0;
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        updateCount += 1;
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
          operation: "add",
        });
        grants = [{ customConnectorId: connector.id, permissionNames: [] }];
        return respond(200, { grants });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Add DeepWiki"));

    await waitFor(() => {
      expect(updateCount).toBe(1);
      expect(screen.getByLabelText("Remove DeepWiki")).toBeInTheDocument();
    });
  });

  it("selects an MCP custom connector account", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = mcpCustomConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    const teamAccount = customAccount(
      "10000000-0000-4000-8000-000000000031",
      connector.id,
      "Team",
      true,
    );
    const personalAccount = customAccount(
      "10000000-0000-4000-8000-000000000032",
      connector.id,
      "Personal",
      false,
    );
    let selectedAccount: ConnectorAccountConnection | null = null;
    mockThread();
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        grants: [{ customConnectorId: connector.id, permissionNames: [] }],
      });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: teamAccount.target,
            accountCount: 2,
            attentionCount: 0,
            defaultConnection: teamAccount,
          },
        ],
      });
    });
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        expect(query).toMatchObject({
          kind: "custom",
          customConnectorId: connector.id,
          limit: 50,
        });
        return respond(200, {
          connections: [teamAccount, personalAccount],
          nextCursor: null,
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ respond }) => {
        return respond(200, {
          selections: selectedAccount
            ? [
                {
                  connectionId: selectedAccount.id,
                  target: selectedAccount.target,
                },
              ]
            : [],
          selectedConnections: selectedAccount ? [selectedAccount] : [],
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.update,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          connectionId: personalAccount.id,
          target: personalAccount.target,
        });
        selectedAccount = personalAccount;
        return respond(200, body);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ConnectorAccounts]: true,
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(
      await screen.findByLabelText("DeepWiki · Using default account: Team"),
    );
    await user.click(screen.getByRole("radio", { name: /Personal/u }));

    await waitFor(() => {
      expect(selectedAccount).toBe(personalAccount);
    });
  });

  it("keeps a connected integration-managed connector available to the agent", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = managedFeishuConnector({
      connected: true,
      missingRequiredFields: [],
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        grants: [
          {
            customConnectorId: connector.id,
            permissionNames: ["standard:use"],
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: { kind: "custom", customConnectorId: connector.id },
            accountCount: 2,
            attentionCount: 0,
            defaultConnection: null,
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));

    await expect(
      screen.findByLabelText("Remove Feishu"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText(/Feishu ·/u)).not.toBeInTheDocument();
  });

  it("keeps authorized MCP custom connectors removable while disabled", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = mcpCustomConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    let grants: AgentCustomConnectorGrant[] = [
      { customConnectorId: connector.id, permissionNames: [] },
    ];
    let updateCount = 0;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, { grants });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
          operation: "remove",
        });
        updateCount += 1;
        grants = [];
        return respond(200, { grants });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: false },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Remove DeepWiki"));

    await waitFor(() => {
      expect(updateCount).toBe(1);
      expect(screen.queryByText("DeepWiki")).not.toBeInTheDocument();
    });
  });

  it("does not create an empty grant for a permissioned custom connector", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
      permissionBundleRef: "builtin:feishu@1",
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, { grants: [] });
    });
    let updateCount = 0;
    context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
      updateCount += 1;
      return respond(200, { grants: [] });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await user.click(within(composer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Add Acme Search"));

    await waitFor(() => {
      expect(updateCount).toBe(0);
      expect(screen.getByLabelText("Add Acme Search")).toBeInTheDocument();
    });
  });

  it("connects a custom connector for only the active agent", async () => {
    const user = userEvent.setup({ delay: null });
    const connector = customConnector();
    context.store.set(setCustomConnectorConnectField$, {
      key: "secret",
      value: "stale-secret",
    });
    mockAgent({ includeOtherAgent: true });
    mockCatalog([]);
    let connected = false;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          connected
            ? {
                ...connector,
                connected: true,
                missingRequiredFields: [],
                configuredFieldKeys: ["secret"],
              }
            : connector,
        ],
      });
    });
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body).toStrictEqual({
          account: { intent: "add" },
          values: [{ key: "secret", kind: "secret", value: "acme-secret" }],
        });
        connected = true;
        return respond(200, {
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        });
      },
    );
    const updatedAgentIds: string[] = [];
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(body).toStrictEqual({
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
          operation: "add",
        });
        updatedAgentIds.push(params.id);
        return respond(200, {
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
        });
      },
    );
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const dialog = await openAddConnectorsDialog(user);
    await user.type(
      within(dialog).getByPlaceholderText(/Find connectors/u),
      "API.ACME.TEST",
    );
    await user.click(
      within(dialog).getByLabelText(`Connect ${connector.displayName}`),
    );

    const connectDialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    expect(dialog).not.toBeInTheDocument();
    expect(within(connectDialog).getByLabelText("Secret")).toHaveValue("");
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

  it("excludes an unconnected integration-managed connector from add flows", async () => {
    const user = userEvent.setup({ delay: null });
    const standardConnector = customConnector();
    const managedConnector = managedFeishuConnector();
    mockCatalog([]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [standardConnector, managedConnector],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const dialog = await openAddConnectorsDialog(user);
    expect(
      within(dialog).getByLabelText("Connect Acme Search"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("Connect Feishu"),
    ).not.toBeInTheDocument();
  });

  it("starts a single OAuth connector without an intermediate modal", async () => {
    const user = userEvent.setup({ delay: null });
    mockCatalog([
      connectorStatus({
        slug: "google-analytics",
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
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("google-analytics");
        expect(body).toMatchObject({
          account: { intent: "add" },
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/analytics/authorize",
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

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
        slug: "stripe",
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
      connectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCount += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body).toStrictEqual({
          account: { intent: "add" },
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, {
          id: crypto.randomUUID(),
          slug: params.connectorSlug,
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
      userConnectorsContract.update,
      ({ body, params, respond }) => {
        authorizationUpdateCount += 1;
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledConnectorSlugs: ["stripe"],
          operation: "add",
        });
        return respond(200, {
          enabledConnectorSlugs: ["stripe"],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

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
        slug: "axiom",
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

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const dialog = await openAddConnectorsDialog(user);
    await user.click(within(dialog).getByLabelText("Connect Axiom"));

    await expect(
      screen.findByRole("dialog", { name: "Axiom" }),
    ).resolves.toBeInTheDocument();
  });

  it("searches beyond featured connectors without loading the full catalog", async () => {
    const user = userEvent.setup({ delay: null });
    const github = connectorStatus({
      slug: "github",
      label: "GitHub",
      authMethods: [],
    });
    const axiom = connectorStatus({
      slug: "axiom",
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
    });
    const discoveryKeywords: (string | undefined)[] = [];
    let fullCatalogRequests = 0;
    context.mocks.api(
      connectorCatalogContract.discovery,
      ({ query, respond }) => {
        discoveryKeywords.push(query.keyword);
        return respond(200, {
          connectors: query.keyword ? [axiom] : [github],
          totalConnectorCount: 347,
        });
      },
    );
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      fullCatalogRequests += 1;
      return respond(200, { connectors: [github, axiom] });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const dialog = await openAddConnectorsDialog(user);
    await user.type(
      within(dialog).getByPlaceholderText(/Find connectors/u),
      "Axiom",
    );
    await user.click(await within(dialog).findByLabelText("Connect Axiom"));

    await expect(
      screen.findByRole("dialog", { name: "Axiom" }),
    ).resolves.toBeInTheDocument();
    expect(discoveryKeywords).toContain("Axiom");
    expect(fullCatalogRequests).toBe(0);
  });
});
